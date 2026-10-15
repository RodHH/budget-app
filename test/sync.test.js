import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

async function connected() {
  const t = makeApp();
  const { public_token } = await t.plaid.sandboxPublicTokenCreate({ institution_id: 'ins_1', institution_name: 'Test Bank' });
  // Pre-create the bank's accounts so the first sync has something to attach to.
  const origExchange = t.plaid.publicTokenExchange.bind(t.plaid);
  let token;
  t.plaid.publicTokenExchange = async (p) => { t.plaid.publicTokenExchange = origExchange; const r = await origExchange(p); token = r.access_token; t.plaid.addAccount(token, { name: 'Checking', mask: '1111', account_id: 'acc_chk' }); t.plaid.addAccount(token, { name: 'Card', mask: '2222', type: 'credit', account_id: 'acc_card' }); return r; };
  const res = await t.call('POST', '/api/plaid/exchange', { public_token, institution: { institution_id: 'ins_1', name: 'Test Bank' }, accounts: [{ mask: '1111' }] });
  return { t, token, itemId: res.item.id };
}
const rows = (t) => t.db.all('SELECT * FROM transactions WHERE deleted_at IS NULL ORDER BY id');
const sync = (t, id) => t.call('POST', `/api/plaid/items/${id}/sync`);

test('initial sync imports accounts and maps Plaid categories; access token stays encrypted', async () => {
  const { t, token, itemId } = await connected();
  t.plaid.add(token, { amount: 5.75, date: '2026-10-10', name: 'STARBUCKS 123', merchant_name: 'Starbucks', pfc: 'FOOD_AND_DRINK/FOOD_AND_DRINK_COFFEE' });
  t.plaid.add(token, { amount: -2500, date: '2026-10-01', name: 'PAYROLL', pfc: 'INCOME/INCOME_WAGES' });
  await sync(t, itemId);
  const r = rows(t);
  assert.equal(r.length, 2);
  assert.equal(r[0].amount_cents, -575);
  assert.equal(r[0].category_id, t.cat('coffee'));
  assert.equal(r[1].category_id, t.cat('paycheck'));
  assert.equal(r[0].is_sandbox, 1);
  const item = t.db.get('SELECT * FROM plaid_items');
  assert.ok(!item.access_token_enc.includes(token));
  assert.equal(t.secrets.decrypt(item.access_token_enc), token);
  assert.ok(item.last_success_at);
  const boot = await t.call('GET', '/api/bootstrap');
  assert.equal(JSON.stringify(boot).includes(token), false, 'token never sent to the browser');
  assert.equal(JSON.stringify(boot).includes('access_token_enc'), false);
});

test('duplicate imports: replaying the same changes never creates duplicates', async () => {
  const { t, token, itemId } = await connected();
  for (let i = 0; i < 5; i++) t.plaid.add(token, { amount: 10 + i, date: '2026-10-0' + (i + 1), name: `SHOP ${i}` });
  await sync(t, itemId);
  // Simulate a crash before the cursor was saved: rewind and sync again.
  t.db.run('UPDATE plaid_items SET cursor = NULL');
  await sync(t, itemId);
  await sync(t, itemId);
  assert.equal(rows(t).length, 5);
});

test('pagination with has_more, and a mutation mid-pagination restarts cleanly', async () => {
  const { t, token, itemId } = await connected();
  for (let i = 0; i < 600; i++) t.plaid.add(token, { amount: 1, date: '2026-10-02', name: `ITEM ${i}` });
  t.plaid.mutateDuringNextPagination(token);
  const r = await sync(t, itemId);
  assert.equal(r.ok, true);
  assert.equal(rows(t).length, 600);
});

for (const removeFirst of [false, true]) {
  test(`pending → posted keeps your edits (removal reported ${removeFirst ? 'before' : 'after'} the posted txn)`, async () => {
    const { t, token, itemId } = await connected();
    const p = t.plaid.add(token, { amount: 40, date: '2026-10-12', name: 'SQ *BISTRO', pending: true, pfc: 'FOOD_AND_DRINK/FOOD_AND_DRINK_RESTAURANT' });
    await sync(t, itemId);
    const [pend] = rows(t);
    assert.equal(pend.pending, 1);
    await t.call('PATCH', `/api/transactions/${pend.id}`, { category_id: t.cat('gifts'), notes: 'Birthday dinner', merchant: 'Bistro (Sam’s birthday)' });
    if (removeFirst) {
      // Removal arrives in one sync, the posted version in the next.
      t.plaid.remove(token, p.transaction_id);
      await sync(t, itemId);
      assert.equal(rows(t).length, 0);
    }
    t.plaid.post(token, p.transaction_id, { amount: 48, date: '2026-10-13' }, { removeFirst: false });
    await sync(t, itemId);
    const r = rows(t);
    assert.equal(r.length, 1, 'one transaction, not two');
    assert.equal(r[0].id, pend.id, 'same row, converted in place');
    assert.equal(r[0].pending, 0);
    assert.equal(r[0].amount_cents, -4800, 'tip added on posting');
    assert.equal(r[0].category_id, t.cat('gifts'));
    assert.equal(r[0].notes, 'Birthday dinner');
    assert.equal(r[0].merchant, 'Bistro (Sam’s birthday)');
    const d = await t.call('GET', '/api/dashboard?month=2026-10');
    assert.equal(d.spending_cents, 4800);
  });
}

test('modified and removed transactions; removed ones stop counting', async () => {
  const { t, token, itemId } = await connected();
  const a = t.plaid.add(token, { amount: 20, date: '2026-10-05', name: 'SHOP A' });
  const b = t.plaid.add(token, { amount: 30, date: '2026-10-06', name: 'SHOP B' });
  await sync(t, itemId);
  t.plaid.modify(token, a.transaction_id, { amount: 25 });
  t.plaid.remove(token, b.transaction_id);
  await sync(t, itemId);
  const r = rows(t);
  assert.equal(r.length, 1);
  assert.equal(r[0].amount_cents, -2500);
  assert.equal((await t.call('GET', '/api/dashboard?month=2026-10')).spending_cents, 2500);
});

test('merchant rules apply to synced transactions but never override a manual category', async () => {
  const { t, token, itemId } = await connected();
  await t.call('POST', '/api/rules', { match_type: 'contains', pattern: 'starbucks', category_id: t.cat('coffee') });
  const s = t.plaid.add(token, { amount: 6, date: '2026-10-05', name: 'STARBUCKS #9', merchant_name: null, pfc: 'FOOD_AND_DRINK/FOOD_AND_DRINK_RESTAURANT' });
  await sync(t, itemId);
  const [row] = rows(t);
  assert.equal(row.category_id, t.cat('coffee'));
  await t.call('PATCH', `/api/transactions/${row.id}`, { category_id: t.cat('gifts') });
  t.plaid.modify(token, s.transaction_id, { amount: 7 });
  await sync(t, itemId);
  assert.equal(rows(t)[0].category_id, t.cat('gifts'));
});

test('transfers and card payments from the bank are excluded from spending', async () => {
  const { t, token, itemId } = await connected();
  t.plaid.add(token, { account_id: 'acc_chk', amount: 500, date: '2026-10-05', name: 'PAYMENT TO CARD', pfc: 'LOAN_PAYMENTS/LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
  t.plaid.add(token, { account_id: 'acc_card', amount: -500, date: '2026-10-05', name: 'PAYMENT THANK YOU', pfc: 'TRANSFER_IN/TRANSFER_IN_ACCOUNT_TRANSFER' });
  t.plaid.add(token, { account_id: 'acc_card', amount: 80, date: '2026-10-03', name: 'GROCER', pfc: 'FOOD_AND_DRINK/FOOD_AND_DRINK_GROCERIES' });
  t.plaid.add(token, { account_id: 'acc_card', amount: -15, date: '2026-10-04', name: 'GROCER REFUND', pfc: 'FOOD_AND_DRINK/FOOD_AND_DRINK_GROCERIES' });
  await sync(t, itemId);
  const d = await t.call('GET', '/api/dashboard?month=2026-10');
  assert.equal(d.spending_cents, 6500);
  assert.equal(d.income_cents, 0);
});

test('sync errors mark the connection and keep the last successful time', async () => {
  const { t, token, itemId } = await connected();
  const before = t.db.get('SELECT last_success_at FROM plaid_items').last_success_at;
  t.plaid.failNext(token, 'ITEM_LOGIN_REQUIRED');
  const r = await sync(t, itemId);
  assert.equal(r.ok, false);
  const it = t.db.get('SELECT * FROM plaid_items');
  assert.equal(it.status, 'login_required');
  assert.equal(it.last_success_at, before);
  await sync(t, itemId);
  assert.equal(t.db.get('SELECT status FROM plaid_items').status, 'ok');
});

test('connecting the same bank accounts twice is refused before a token is exchanged', async () => {
  const { t } = await connected();
  const calls = t.plaid.calls.filter((c) => c === 'publicTokenExchange').length;
  const { public_token } = await t.plaid.sandboxPublicTokenCreate({ institution_id: 'ins_1' });
  const r = await t.call('POST', '/api/plaid/exchange', { public_token, institution: { institution_id: 'ins_1' }, accounts: [{ mask: '1111' }] }, { 'x-expect-error': '1' });
  assert.equal(r.error, 'duplicate_item');
  assert.equal(t.plaid.calls.filter((c) => c === 'publicTokenExchange').length, calls);
});

test('multiple connections sync independently', async () => {
  const { t, token, itemId } = await connected();
  const p2 = await t.plaid.sandboxPublicTokenCreate({ institution_id: 'ins_2', institution_name: 'Second Bank' });
  const second = await t.call('POST', '/api/plaid/exchange', { public_token: p2.public_token, institution: { institution_id: 'ins_2', name: 'Second Bank' } });
  const tok2 = [...t.plaid.items.keys()].find((k) => k !== token);
  t.plaid.addAccount(tok2, { name: 'Savings', mask: '3333', account_id: 'acc_sav' });
  t.plaid.add(tok2, { account_id: 'acc_sav', amount: 3, date: '2026-10-08', name: 'FEE', pfc: 'BANK_FEES/BANK_FEES_OTHER' });
  t.plaid.failNext(token, 'INTERNAL_SERVER_ERROR');
  const { results } = await t.call('POST', '/api/plaid/sync-all');
  assert.deepEqual(results.map((r) => r.ok), [false, true]);
  const items = (await t.call('GET', '/api/plaid/status')).items;
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.id === second.item.id).accounts.length, 1);
  assert.ok(items.every((i) => i.last_success_at));
  assert.equal(itemId, items[0].id);
});

test('webhook triggers a sync for the matching item', async () => {
  const { t, token } = await connected();
  t.plaid.add(token, { amount: 9, date: '2026-10-09', name: 'LUNCH' });
  const item = t.db.get('SELECT item_id FROM plaid_items');
  const r = await t.app.handle({ method: 'POST', path: '/api/plaid/webhook', headers: {}, body: { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: item.item_id }, rawBody: '{}', query: {} });
  assert.equal(r.status, 200);
  await t.app.idle();
  assert.equal(rows(t).length, 1);
});
