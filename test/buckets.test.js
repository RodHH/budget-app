import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

async function setup() {
  const t = makeApp();
  const savings = (await t.call('POST', '/api/accounts', { name: 'Capital One Savings', type: 'savings', current_balance_cents: 500000 })).account;
  const checking = (await t.call('POST', '/api/accounts', { name: 'Checking', type: 'depository', current_balance_cents: 100000 })).account;
  const mk = async (name, extra = {}) => (await t.call('POST', '/api/buckets', { account_id: savings.id, name, ...extra })).bucket;
  const house = await mk('House Savings', { icon: '🏠', monthly_target_cents: 20000, starting_cents: 300000 });
  const travel = await mk('Travel Savings', { icon: '✈️', monthly_target_cents: 10000, starting_cents: 50000 });
  const view = async () => t.call('GET', '/api/buckets');
  const bal = async (id) => (await view()).buckets.find((b) => b.id === id).balance_cents;
  return { t, savings, checking, house, travel, view, bal };
}

test('buckets: starting amounts, and "not assigned" keeps buckets adding up to the real balance', async () => {
  const { t, savings, checking, house, view } = await setup();
  const v = await view();
  const acct = v.accounts.find((a) => a.id === savings.id);
  assert.equal(acct.assigned_cents, 350000);
  assert.equal(acct.unassigned_cents, 150000);
  assert.ok(!v.accounts.some((a) => a.id === checking.id), 'only savings accounts hold buckets');
  assert.equal(house.balance_cents, 300000);
  assert.equal(house.month_cents, 0, 'money already saved doesn’t count as saved this month');
  assert.equal(house.target_met, false);
  const err = await t.call('POST', '/api/buckets', { account_id: checking.id, name: 'Nope' }, { 'x-expect-error': '1' });
  assert.match(err.message, /savings account/);
  assert.ok((await t.call('GET', '/api/bootstrap')).savings.buckets.length === 2, 'bootstrap carries the buckets');
});

test('buckets: tagging deposits and withdrawals, including splits', async () => {
  const { t, savings, house, travel, bal } = await setup();
  const dep = (await t.call('POST', '/api/transactions', { merchant: 'Transfer from checking', amount_cents: 75000, account_id: savings.id, date: '2026-10-14' })).transaction;
  // Split one deposit: $500 House + $200 Travel, $50 left unassigned.
  const r = await t.call('PATCH', `/api/transactions/${dep.id}`, { buckets: [{ bucket_id: house.id, amount_cents: 50000 }, { bucket_id: travel.id, amount_cents: 20000 }] });
  assert.deepEqual(r.transaction.buckets.map((b) => [b.name, b.amount_cents]), [['House Savings', 50000], ['Travel Savings', 20000]]);
  assert.equal(await bal(house.id), 350000);
  assert.equal(await bal(travel.id), 70000);
  const over = await t.call('PATCH', `/api/transactions/${dep.id}`, { buckets: [{ bucket_id: house.id, amount_cents: 70000 }, { bucket_id: travel.id, amount_cents: 20000 }] }, { 'x-expect-error': '1' });
  assert.match(over.message, /more than the transaction/);

  // A withdrawal tagged to Travel takes money out of Travel.
  const wd = (await t.call('POST', '/api/transactions', { merchant: 'Withdrawal', amount_cents: -30000, account_id: savings.id, date: '2026-10-15', buckets: [{ bucket_id: travel.id }] })).transaction;
  assert.equal(wd.buckets[0].amount_cents, -30000);
  assert.equal(await bal(travel.id), 40000);

  // Untagging puts it back; deleting a tagged transaction removes its effect.
  await t.call('PATCH', `/api/transactions/${wd.id}`, { buckets: [] });
  assert.equal(await bal(travel.id), 70000);
  await t.call('DELETE', `/api/transactions/${dep.id}`);
  assert.equal(await bal(house.id), 300000);
  assert.equal(await bal(travel.id), 50000);
});

test('buckets: a purchase "paid from savings" lowers the bucket but not the category budget', async () => {
  const { t, checking, travel, bal } = await setup();
  const travelCat = (await t.call('POST', '/api/categories', { name: 'Travel', kind: 'expense', icon: '🧳' })).category;
  await t.call('PUT', `/api/categories/${travelCat.id}/budget`, { amount_cents: 20000, period: 'monthly', reset_day: 1 });
  const flight = (await t.call('POST', '/api/transactions', { merchant: 'Delta', amount_cents: -45000, account_id: checking.id, category_id: travelCat.id, date: '2026-10-14' })).transaction;
  await t.call('PATCH', `/api/transactions/${flight.id}`, { buckets: [{ bucket_id: travel.id }] });
  assert.equal(await bal(travel.id), 5000);
  const cat = (await t.call('GET', '/api/bootstrap')).categories.find((c) => c.id === travelCat.id);
  assert.equal(cat.status.spent_cents, 0, 'paid from savings, so the monthly budget is untouched');
  const dash = await t.call('GET', '/api/dashboard?month=2026-10');
  assert.equal(dash.spending_cents, 45000, 'still counts as spending');
  const refund = (await t.call('POST', '/api/transactions', { merchant: 'Refund', amount_cents: 1000, account_id: checking.id, date: '2026-10-14' })).transaction;
  const no = await t.call('PATCH', `/api/transactions/${refund.id}`, { buckets: [{ bucket_id: travel.id }] }, { 'x-expect-error': '1' });
  assert.match(no.message, /money going out/);
});

test('buckets: moving money, deleting, and rules that fill a bucket automatically', async () => {
  const { t, savings, house, travel, bal, view } = await setup();
  await t.call('POST', '/api/buckets/move', { from_bucket_id: house.id, to_bucket_id: travel.id, amount_cents: 25000 });
  assert.equal(await bal(house.id), 275000);
  assert.equal(await bal(travel.id), 75000);
  await t.call('POST', '/api/buckets/move', { from_bucket_id: null, to_bucket_id: travel.id, amount_cents: 10000 });
  assert.equal((await view()).accounts[0].unassigned_cents, 140000);

  const del = await t.call('DELETE', `/api/buckets/${travel.id}`, null, { 'x-expect-error': '1' });
  assert.match(del.message, /Move this bucket/);
  await t.call('POST', '/api/buckets/move', { from_bucket_id: travel.id, to_bucket_id: null, amount_cents: 85000 });
  await t.call('DELETE', `/api/buckets/${travel.id}`);
  assert.equal((await view()).buckets.length, 1);

  // Rule: transfers named "House fund" go to House Savings.
  await t.call('POST', '/api/rules', { pattern: 'House fund', match_type: 'contains', bucket_id: house.id });
  const dep = (await t.call('POST', '/api/transactions', { merchant: 'House fund transfer', amount_cents: 20000, account_id: savings.id, date: '2026-10-14' })).transaction;
  assert.deepEqual(dep.buckets.map((b) => b.name), ['House Savings']);
  assert.equal(await bal(house.id), 295000);
  const activity = (await t.call('GET', `/api/buckets/${house.id}/activity`)).activity;
  assert.deepEqual(activity.map((a) => a.amount_cents), [20000, -25000, 300000]);
});

test('buckets: bank-synced savings deposits are tagged by rules and follow pending → posted', async () => {
  const t = makeApp();
  const p = await t.plaid.sandboxPublicTokenCreate({ institution_id: 'ins_1', institution_name: 'Capital One' });
  await t.call('POST', '/api/plaid/exchange', { public_token: p.public_token, institution: { institution_id: 'ins_1', name: 'Capital One' } });
  const token = [...t.plaid.items.keys()][0];
  t.plaid.addAccount(token, { name: '360 Savings', mask: '9999', account_id: 'acc_sav', subtype: 'savings', current: 1000 });
  await t.call('POST', '/api/plaid/sync-all');
  const savings = t.db.get("SELECT id FROM accounts WHERE plaid_account_id = 'acc_sav'");
  const house = (await t.call('POST', '/api/buckets', { account_id: savings.id, name: 'House' })).bucket;
  await t.call('POST', '/api/rules', { pattern: 'HOUSE', match_type: 'contains', bucket_id: house.id });
  t.plaid.add(token, { account_id: 'acc_sav', amount: -200, date: '2026-10-14', name: 'HOUSE TRANSFER', pending: true, transaction_id: 'p1' });
  await t.call('POST', '/api/plaid/sync-all');
  const bal = async () => (await t.call('GET', '/api/buckets')).buckets[0].balance_cents;
  assert.equal(await bal(), 20000);
  // The posted version replaces the pending one; the bucket counts it once.
  t.plaid.add(token, { account_id: 'acc_sav', amount: -200, date: '2026-10-15', name: 'HOUSE TRANSFER', transaction_id: 'p2', pending_transaction_id: 'p1' });
  t.plaid.remove?.(token, 'p1');
  await t.call('POST', '/api/plaid/sync-all');
  assert.equal(await bal(), 20000);
});
