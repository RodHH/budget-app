// Savings buckets: "House", "Travel"... inside a real savings account.
//
// Rules:
//  - A bucket's balance is the sum of its moves. Moves on a transaction use the transaction's
//    amount unless a split amount is stored, and stop counting if the bank removes it.
//  - Deposits/withdrawals in the savings account itself are tagged to its buckets ('txn').
//  - A purchase made from another account can be "paid from" a bucket ('paid_from'): the bucket
//    goes down, and the purchase doesn't use up its category's monthly budget.
//  - Not assigned = the account's real balance minus everything in its buckets, so the buckets
//    always add up to what the bank shows.
const SAVINGS_SUBTYPES = new Set(['savings', 'money market', 'cd', 'hsa', 'cash management']);
export const isSavingsAccount = (a) => !!a && SAVINGS_SUBTYPES.has(String(a.subtype || '').toLowerCase());

// Effective amount of a move, and whether it still counts.
const MOVES_FROM = `bucket_moves m LEFT JOIN transactions t ON t.id = m.transaction_id
  WHERE (m.transaction_id IS NULL OR t.deleted_at IS NULL)`;
const AMOUNT = 'COALESCE(m.amount_cents, t.amount_cents)';
const DATE = 'COALESCE(t.date, m.date)';

function monthsBetween(from, to) {
  const [y1, m1] = from.split('-').map(Number);
  const [y2, m2] = to.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

export function bucketsView(db, today) {
  const monthStart = `${today.slice(0, 8)}01`;
  const sums = new Map(db.all(
    `SELECT m.bucket_id AS id, SUM(${AMOUNT}) AS balance,
            SUM(CASE WHEN ${DATE} >= ? AND m.kind != 'start' THEN ${AMOUNT} ELSE 0 END) AS month
     FROM ${MOVES_FROM} GROUP BY m.bucket_id`, [monthStart],
  ).map((r) => [r.id, r]));
  const buckets = db.all('SELECT * FROM savings_buckets ORDER BY sort_order, id').map((b) => {
    const s = sums.get(b.id) || {};
    const balance = s.balance || 0;
    const month = s.month || 0;
    let needed = null;
    if (b.goal_cents && b.goal_date && b.goal_date > today) {
      const months = Math.max(1, monthsBetween(today, b.goal_date));
      needed = Math.max(0, Math.ceil((b.goal_cents - balance) / months));
    }
    return {
      id: b.id, account_id: b.account_id, name: b.name, icon: b.icon, color: b.color, sort_order: b.sort_order,
      monthly_target_cents: b.monthly_target_cents, goal_cents: b.goal_cents, goal_date: b.goal_date,
      balance_cents: balance, month_cents: month,
      goal_pct: b.goal_cents ? Math.max(0, balance / b.goal_cents) : null,
      needed_per_month_cents: needed,
      target_met: b.monthly_target_cents ? month >= b.monthly_target_cents : null,
    };
  });
  const accounts = db.all('SELECT id, name, mask, institution, subtype, current_balance_cents, hidden FROM accounts ORDER BY id')
    .filter(isSavingsAccount)
    .map((a) => {
      const mine = buckets.filter((b) => b.account_id === a.id);
      const assigned = mine.reduce((s, b) => s + b.balance_cents, 0);
      return {
        id: a.id, name: a.name, mask: a.mask, institution: a.institution, hidden: !!a.hidden,
        balance_cents: a.current_balance_cents, assigned_cents: assigned,
        unassigned_cents: a.current_balance_cents == null ? null : a.current_balance_cents - assigned,
        buckets: mine,
      };
    });
  return { accounts, buckets };
}

export function bucketActivity(db, bucketId, limit = 100) {
  return db.all(
    `SELECT m.id, m.kind, m.note, m.transaction_id, ${AMOUNT} AS amount_cents, ${DATE} AS date, t.merchant, a.name AS account_name
     FROM bucket_moves m LEFT JOIN transactions t ON t.id = m.transaction_id LEFT JOIN accounts a ON a.id = t.account_id
     WHERE (m.transaction_id IS NULL OR t.deleted_at IS NULL) AND m.bucket_id = ?
     ORDER BY ${DATE} DESC, m.id DESC LIMIT ?`,
    [bucketId, limit],
  );
}

/** Bucket tags for a set of transactions, keyed by transaction id. */
export function movesForTransactions(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = db.all(
    `SELECT m.transaction_id, m.bucket_id, m.kind, COALESCE(m.amount_cents, t.amount_cents) AS amount_cents, m.amount_cents AS split_cents,
            b.name, b.icon
     FROM bucket_moves m JOIN transactions t ON t.id = m.transaction_id JOIN savings_buckets b ON b.id = m.bucket_id
     WHERE m.transaction_id IN (${ids.map(() => '?').join(',')}) ORDER BY m.id`, ids,
  );
  for (const r of rows) {
    if (!out.has(r.transaction_id)) out.set(r.transaction_id, []);
    out.get(r.transaction_id).push({ bucket_id: r.bucket_id, kind: r.kind, amount_cents: r.amount_cents, split: r.split_cents != null, name: r.name, icon: r.icon });
  }
  return out;
}

/**
 * Tag a transaction to buckets, replacing earlier tags. `moves` is [{ bucket_id, amount_cents? }].
 * Throws an Error with a user-facing message when the tags don't make sense.
 */
export function setTransactionBuckets(db, txn, moves, now) {
  const account = txn.account_id ? db.get('SELECT * FROM accounts WHERE id = ?', [txn.account_id]) : null;
  const inSavings = isSavingsAccount(account);
  const rows = [];
  if (moves.length) {
    const buckets = moves.map((m) => {
      const b = db.get('SELECT * FROM savings_buckets WHERE id = ?', [Number(m.bucket_id)]);
      if (!b) throw new Error('That savings bucket no longer exists.');
      return b;
    });
    if (new Set(buckets.map((b) => b.id)).size !== buckets.length) throw new Error('Each bucket can only be used once per transaction.');
    if (inSavings && buckets.every((b) => b.account_id === account.id)) {
      if (moves.length === 1) rows.push({ bucket_id: buckets[0].id, kind: 'txn', amount: null });
      else {
        const sign = Math.sign(txn.amount_cents);
        let total = 0;
        moves.forEach((m, i) => {
          const a = Math.round(Number(m.amount_cents));
          if (!Number.isFinite(a) || a === 0) throw new Error('Enter an amount for each bucket.');
          const signed = Math.abs(a) * sign;
          total += signed;
          rows.push({ bucket_id: buckets[i].id, kind: 'txn', amount: signed });
        });
        if (Math.abs(total) > Math.abs(txn.amount_cents)) throw new Error('The split adds up to more than the transaction.');
      }
    } else {
      if (inSavings) throw new Error('Pick buckets that belong to this savings account.');
      if (moves.length > 1) throw new Error('A purchase can be paid from one savings bucket.');
      if (txn.amount_cents >= 0) throw new Error('Only money going out can be paid from savings.');
      rows.push({ bucket_id: buckets[0].id, kind: 'paid_from', amount: null });
    }
  }
  db.tx(() => {
    db.run('DELETE FROM bucket_moves WHERE transaction_id = ?', [txn.id]);
    for (const r of rows) {
      db.run('INSERT INTO bucket_moves (bucket_id, transaction_id, kind, amount_cents, created_at) VALUES (?,?,?,?,?)', [r.bucket_id, txn.id, r.kind, r.amount, now]);
    }
  });
}

/** A rule's bucket applies to new transactions in that bucket's own savings account. */
export function applyRuleBucket(db, rule, txnId, accountId, now) {
  if (!rule?.bucket_id || !accountId) return false;
  const b = db.get('SELECT account_id FROM savings_buckets WHERE id = ?', [rule.bucket_id]);
  if (!b || b.account_id !== accountId) return false;
  if (db.get('SELECT 1 x FROM bucket_moves WHERE transaction_id = ?', [txnId])) return false;
  db.run("INSERT INTO bucket_moves (bucket_id, transaction_id, kind, created_at) VALUES (?,?, 'txn', ?)", [rule.bucket_id, txnId, now]);
  return true;
}

/** Remove bucket tags and buckets tied to accounts that are about to be deleted. */
export function deleteBucketDataForAccounts(db, accountSql, params = []) {
  const inBuckets = `SELECT id FROM savings_buckets WHERE account_id IN (${accountSql})`;
  db.run(`DELETE FROM bucket_moves WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id IN (${accountSql}))`, params);
  db.run(`UPDATE rules SET bucket_id = NULL WHERE bucket_id IN (${inBuckets})`, params);
  db.run(`DELETE FROM bucket_moves WHERE bucket_id IN (${inBuckets})`, params);
  db.run(`DELETE FROM savings_buckets WHERE account_id IN (${accountSql})`, params);
}
