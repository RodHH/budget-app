// Plaid /transactions/sync → local database.
//
// Guarantees (all covered by tests):
//  - Idempotent: replaying the same page (e.g. after a crash before the cursor was saved)
//    updates rows in place by plaid_transaction_id; it never creates duplicates.
//  - Atomic: transaction changes and the new cursor are committed together.
//  - Pending → posted: when Plaid sends a posted transaction with pending_transaction_id,
//    the existing pending row is converted in place, keeping your category, notes and
//    merchant edits. Removed rows are soft-deleted so this still works if Plaid reports the
//    removal of the pending row before the posted one arrives.
//  - Your manual category / merchant edits are never overwritten by later bank updates.
import { categoryIdForKey, systemKeyForPlaid } from './categories.js';
import { findRule, loadRules } from './rules.js';

export class SyncError extends Error {
  constructor(code, message) { super(message || code); this.error_code = code; }
}

const RETRYABLE = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';
const LOGIN_CODES = new Set(['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'ACCESS_NOT_GRANTED']);

export async function syncItem(ctx, item) {
  const { db, plaid, secrets } = ctx;
  const now = ctx.nowIso();
  db.run('UPDATE plaid_items SET last_attempt_at = ? WHERE id = ?', [now, item.id]);
  const accessToken = secrets.decrypt(item.access_token_enc);
  for (let attempt = 0; ; attempt++) {
    const batch = { added: [], modified: [], removed: [], accounts: [] };
    let cursor = item.cursor || undefined;
    try {
      let resp;
      do {
        resp = await plaid.transactionsSync({ access_token: accessToken, cursor, count: 250 });
        batch.added.push(...(resp.added || []));
        batch.modified.push(...(resp.modified || []));
        batch.removed.push(...(resp.removed || []));
        if (resp.accounts?.length) batch.accounts = resp.accounts;
        cursor = resp.next_cursor;
      } while (resp.has_more);
    } catch (e) {
      if (e.error_code === RETRYABLE && attempt < 3) continue;
      const status = LOGIN_CODES.has(e.error_code) ? 'login_required' : 'error';
      db.run('UPDATE plaid_items SET status = ?, last_error = ? WHERE id = ?', [status, e.error_code || e.message, item.id]);
      return { ok: false, error: e.error_code || e.message, status };
    }
    const counts = db.tx(() => applySync(db, item, batch, cursor, ctx.nowIso()));
    return { ok: true, ...counts };
  }
}

export function upsertPlaidAccounts(db, item, accounts, now) {
  const sandbox = item.environment === 'production' ? 0 : 1;
  for (const a of accounts) {
    const cur = a.balances?.current;
    const avail = a.balances?.available;
    const cents = (v) => (v === null || v === undefined ? null : Math.round(v * 100));
    const existing = db.get('SELECT id FROM accounts WHERE plaid_account_id = ?', [a.account_id]);
    if (existing) {
      db.run(
        `UPDATE accounts SET plaid_item_id = ?, type = ?, subtype = ?, mask = ?, institution = ?,
           current_balance_cents = ?, available_balance_cents = ?, currency = ?, is_sandbox = ? WHERE id = ?`,
        [item.id, a.type || 'depository', a.subtype || null, a.mask || null, item.institution_name,
          cents(cur), cents(avail), a.balances?.iso_currency_code || 'USD', sandbox, existing.id],
      );
    } else {
      db.run(
        `INSERT INTO accounts (name, type, subtype, mask, institution, source, plaid_item_id, plaid_account_id,
           current_balance_cents, available_balance_cents, currency, is_sandbox, created_at)
         VALUES (?,?,?,?,?, 'plaid', ?,?,?,?,?,?,?)`,
        [a.name || a.official_name || 'Account', a.type || 'depository', a.subtype || null, a.mask || null,
          item.institution_name, item.id, a.account_id, cents(cur), cents(avail),
          a.balances?.iso_currency_code || 'USD', sandbox, now],
      );
    }
  }
}

function autoCategory(db, rules, t, merchant) {
  const rule = findRule(rules, { merchant, original_name: t.name });
  if (rule && rule.category_id) return { category_id: rule.category_id, rename: rule.rename_to || null };
  return { category_id: categoryIdForKey(db, systemKeyForPlaid(t.personal_finance_category)), rename: rule?.rename_to || null };
}

export function applySync(db, item, batch, cursor, now) {
  upsertPlaidAccounts(db, item, batch.accounts, now);
  const rules = loadRules(db);
  const sandbox = item.environment === 'production' ? 0 : 1;
  const accountId = (plaidAccountId) => db.get('SELECT id FROM accounts WHERE plaid_account_id = ?', [plaidAccountId])?.id ?? null;
  const counts = { added: 0, updated: 0, removed: 0, converted: 0 };

  const upsert = (t) => {
    const amount = -Math.round(Number(t.amount) * 100); // Plaid: positive = money out
    const date = t.authorized_date || t.date;
    const bankMerchant = t.merchant_name || t.name;
    const pfc = t.personal_finance_category;
    const pfcStr = pfc ? `${pfc.primary}/${pfc.detailed}` : null;
    let row = db.get('SELECT * FROM transactions WHERE plaid_transaction_id = ?', [t.transaction_id]);
    let pendingRow = null;
    if (t.pending_transaction_id) {
      pendingRow = db.get('SELECT * FROM transactions WHERE plaid_transaction_id = ?', [t.pending_transaction_id]);
    }
    if (!row && pendingRow) {
      row = pendingRow; // convert pending → posted in place
      counts.converted++;
    } else if (row && pendingRow && pendingRow.id !== row.id) {
      // Both exist: carry your edits over from the pending row, then retire it.
      if (!row.category_locked && pendingRow.category_locked) {
        db.run('UPDATE transactions SET category_id = ?, category_locked = 1 WHERE id = ?', [pendingRow.category_id, row.id]);
      }
      if (pendingRow.notes && !row.notes) db.run('UPDATE transactions SET notes = ? WHERE id = ?', [pendingRow.notes, row.id]);
      db.run('UPDATE transactions SET deleted_at = ? WHERE id = ?', [now, pendingRow.id]);
      row = db.get('SELECT * FROM transactions WHERE id = ?', [row.id]);
    }
    const auto = autoCategory(db, rules, t, bankMerchant);
    if (row) {
      const category = row.category_locked ? row.category_id : auto.category_id;
      const merchant = row.merchant_locked ? row.merchant : (auto.rename || bankMerchant);
      db.run(
        `UPDATE transactions SET plaid_transaction_id = ?, account_id = ?, date = ?, amount_cents = ?,
           original_name = ?, merchant = ?, category_id = ?, pending = ?, plaid_category = ?,
           is_sandbox = ?, deleted_at = NULL, updated_at = ? WHERE id = ?`,
        [t.transaction_id, accountId(t.account_id), date, amount, t.name, merchant, category,
          t.pending ? 1 : 0, pfcStr, sandbox, now, row.id],
      );
      counts.updated++;
    } else {
      db.run(
        `INSERT INTO transactions (account_id, date, amount_cents, merchant, original_name, category_id,
           pending, source, plaid_transaction_id, plaid_category, is_sandbox, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'plaid', ?,?,?,?,?)`,
        [accountId(t.account_id), date, amount, auto.rename || bankMerchant, t.name, auto.category_id,
          t.pending ? 1 : 0, t.transaction_id, pfcStr, sandbox, now, now],
      );
      counts.added++;
    }
  };

  for (const t of batch.added) upsert(t);
  for (const t of batch.modified) upsert(t);
  for (const r of batch.removed) {
    const res = db.run('UPDATE transactions SET deleted_at = ?, updated_at = ? WHERE plaid_transaction_id = ? AND deleted_at IS NULL', [now, now, r.transaction_id]);
    counts.removed += res.changes;
  }
  db.run(
    "UPDATE plaid_items SET cursor = ?, status = 'ok', last_error = NULL, last_success_at = ? WHERE id = ?",
    [cursor || null, now, item.id],
  );
  return counts;
}
