// Optional sample data. Every row created here is flagged is_sample = 1, shown with a
// "Sample" label in the app, and removed in one step by removeSample().
import { addDays } from './dates.js';
import { deleteBucketDataForAccounts } from './buckets.js';

function catId(db, key) {
  return db.get('SELECT id FROM categories WHERE system_key = ?', [key])?.id ?? null;
}

export function hasSample(db) {
  return !!(db.get('SELECT 1 x FROM transactions WHERE is_sample = 1 LIMIT 1') || db.get('SELECT 1 x FROM accounts WHERE is_sample = 1 LIMIT 1'));
}

export function loadSample(db, today, now) {
  if (hasSample(db)) return { ok: true, already: true };
  return db.tx(() => {
    const acct = (name, type, subtype, bal, mask) => db.run(
      `INSERT INTO accounts (name, type, subtype, mask, institution, source, current_balance_cents, is_sample, created_at)
       VALUES (?,?,?,?, 'Sample data', 'manual', ?, 1, ?)`,
      [name, type, subtype, mask, bal, now],
    ).lastInsertRowid;
    const checking = acct('Sample Checking', 'depository', 'checking', 352040, '1234');
    const card = acct('Sample Credit Card', 'credit', 'credit card', 48215, '9876');
    const tx = (account, back, cents, merchant, key, extra = {}) => db.run(
      `INSERT INTO transactions (account_id, date, amount_cents, merchant, original_name, category_id, pending,
         notes, source, is_sample, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?, 'manual', 1, ?, ?)`,
      [account, addDays(today, -back), cents, merchant, extra.original || merchant.toUpperCase(), key ? catId(db, key) : null,
        extra.pending ? 1 : 0, extra.notes || null, now, now],
    );
    for (let back = 0; back <= 60; back += 14) tx(checking, back + 3, 265000, 'Acme Corp payroll', 'paycheck');
    const daily = [
      ['Starbucks', -585, 'coffee'], ['Whole Foods Market', -8412, 'groceries'], ['Chipotle', -1430, 'restaurants'],
      ['Shell', -4620, 'transportation'], ['Target', -6375, 'shopping'], ["Trader Joe's", -5240, 'groceries'],
      ['Uber', -1860, 'transportation'], ['Blue Bottle Coffee', -650, 'coffee'], ['Netflix', -1549, 'subscriptions'],
    ];
    for (let back = 60; back >= 1; back--) {
      const [m, c, k] = daily[back % daily.length];
      tx(card, back, Math.round(c * (0.8 + ((back * 37) % 40) / 100)), m, k);
    }
    for (const back of [48, 18]) {
      tx(checking, back, -195000, 'Oakwood Apartments', 'housing');
      tx(checking, back - 1, -12890, 'City Power & Light', 'utilities');
      tx(checking, back - 2, -64000, 'Payment to Sample Credit Card', 'cc_payment', { notes: 'Excluded from spending: it pays off purchases already counted on the card.' });
      tx(card, back - 2, 64000, 'Payment received – thank you', 'cc_payment');
      tx(checking, back - 4, -30000, 'Transfer to savings', 'transfer');
    }
    tx(card, 5, 2499, 'Target', 'shopping', { notes: 'Refund: reduces Shopping spending.', original: 'TARGET REFUND' });
    tx(card, 0, -3840, 'Corner Bistro', 'restaurants', { pending: true });
    tx(card, 0, -585, 'Starbucks', null, { pending: true, original: 'STARBUCKS STORE 1123' });

    const budget = (key, cents, period, extra = {}) => {
      const id = catId(db, key);
      if (!id || db.get('SELECT 1 x FROM budgets WHERE category_id = ?', [id])) return;
      db.run(
        `INSERT INTO budgets (category_id, amount_cents, period, reset_day, reset_weekday, anchor_date, alerts_enabled, is_sample, updated_at)
         VALUES (?,?,?,?,?,?,1,1,?)`,
        [id, cents, period, extra.reset_day ?? 1, extra.reset_weekday ?? null, null, now],
      );
    };
    budget('groceries', 60000, 'monthly');
    budget('restaurants', 30000, 'monthly');
    budget('coffee', 4000, 'weekly', { reset_weekday: 1 });
    budget('shopping', 25000, 'monthly');
    budget('transportation', 20000, 'monthly');
    budget('subscriptions', 5000, 'monthly');
    if (!db.get("SELECT 1 x FROM rules WHERE lower(pattern) = 'starbucks'")) {
      db.run(
        "INSERT INTO rules (match_type, pattern, category_id, sort_order, is_sample, created_at) VALUES ('contains', 'Starbucks', ?, 0, 1, ?)",
        [catId(db, 'coffee'), now],
      );
    }
    // The pending Starbucks charge above was left uncategorized; apply the sample rule to it.
    db.run("UPDATE transactions SET category_id = ? WHERE is_sample = 1 AND category_id IS NULL AND merchant = 'Starbucks'", [catId(db, 'coffee')]);
    return { ok: true };
  });
}

export function removeSample(db) {
  return db.tx(() => {
    const sampleBudgetCats = db.all('SELECT category_id FROM budgets WHERE is_sample = 1').map((r) => r.category_id);
    db.run('DELETE FROM bucket_moves WHERE transaction_id IN (SELECT id FROM transactions WHERE is_sample = 1)');
    deleteBucketDataForAccounts(db, 'SELECT id FROM accounts WHERE is_sample = 1');
    db.run('DELETE FROM transactions WHERE is_sample = 1');
    db.run('DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE is_sample = 1)');
    db.run('DELETE FROM accounts WHERE is_sample = 1');
    db.run('DELETE FROM budgets WHERE is_sample = 1');
    db.run('DELETE FROM rules WHERE is_sample = 1');
    if (sampleBudgetCats.length) {
      db.run(`DELETE FROM alert_events WHERE category_id IN (${sampleBudgetCats.map(() => '?').join(',')})`, sampleBudgetCats);
    }
    return { ok: true };
  });
}
