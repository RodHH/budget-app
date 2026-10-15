import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

test('refunds reduce category spending; transfers and card payments are excluded', async () => {
  const t = makeApp();
  const groceries = t.cat('groceries');
  await t.spend('Whole Foods', 100, '2026-10-03', { category_id: groceries });
  await t.call('POST', '/api/transactions', { merchant: 'Whole Foods refund', amount_cents: 2500, date: '2026-10-05', category_id: groceries });
  await t.call('POST', '/api/transactions', { merchant: 'Paycheck', amount_cents: 300000, date: '2026-10-01', category_id: t.cat('paycheck') });
  // Credit card payment: out of checking AND into the card. Neither side is spending or income.
  await t.call('POST', '/api/transactions', { merchant: 'Payment to card', amount_cents: -50000, date: '2026-10-10', category_id: t.cat('cc_payment') });
  await t.call('POST', '/api/transactions', { merchant: 'Payment thank you', amount_cents: 50000, date: '2026-10-10', category_id: t.cat('cc_payment') });
  await t.call('POST', '/api/transactions', { merchant: 'To savings', amount_cents: -20000, date: '2026-10-11', category_id: t.cat('transfer') });
  const d = await t.call('GET', '/api/dashboard?month=2026-10');
  assert.equal(d.spending_cents, 7500);
  assert.equal(d.income_cents, 300000);
  assert.equal(d.net_cents, 292500);
  assert.equal(d.by_category.find((c) => c.category_id === groceries).spent_cents, 7500);
});

test('a refund larger than this period’s purchases makes spending negative, not hidden', async () => {
  const t = makeApp();
  const shopping = t.cat('shopping');
  await t.call('PUT', `/api/categories/${shopping}/budget`, { amount_cents: 10000, period: 'monthly' });
  await t.spend('Target', 20, '2026-10-02', { category_id: shopping });
  await t.call('POST', '/api/transactions', { merchant: 'Target refund (Sept purchase)', amount_cents: 6000, date: '2026-10-04', category_id: shopping });
  const { categories } = await t.call('GET', '/api/categories');
  const s = categories.find((c) => c.id === shopping).status;
  assert.equal(s.spent_cents, -4000);
  assert.equal(s.remaining_cents, 14000);
});

test('excluded transactions and the include-pending setting', async () => {
  const t = makeApp();
  const r = t.cat('restaurants');
  await t.spend('Bistro', 40, '2026-10-12', { category_id: r, pending: true });
  const ex = await t.spend('Work dinner (reimbursed)', 90, '2026-10-12', { category_id: r });
  await t.call('PATCH', `/api/transactions/${ex.transaction.id}`, { excluded: true });
  let d = await t.call('GET', '/api/dashboard?month=2026-10');
  assert.equal(d.spending_cents, 4000);
  await t.call('PUT', '/api/settings', { include_pending: false });
  d = await t.call('GET', '/api/dashboard?month=2026-10');
  assert.equal(d.spending_cents, 0);
});

test('uncategorized money out is spending and money in is income', async () => {
  const t = makeApp();
  await t.spend('Mystery shop', 12, '2026-10-02');
  await t.call('POST', '/api/transactions', { merchant: 'Venmo from Sam', amount_cents: 3000, date: '2026-10-03' });
  const d = await t.call('GET', '/api/dashboard?month=2026-10');
  assert.equal(d.spending_cents, 1200);
  assert.equal(d.income_cents, 3000);
  assert.equal(d.counts.uncategorized, 2);
});

test('budget period boundaries: last day counts, reset day starts fresh', async () => {
  const t = makeApp({ today: '2026-10-15' });
  const coffee = t.cat('coffee');
  await t.call('PUT', `/api/categories/${coffee}/budget`, { amount_cents: 5000, period: 'monthly', reset_day: 15 });
  await t.spend('Cafe', 10, '2026-10-14', { category_id: coffee }); // previous period
  await t.spend('Cafe', 7, '2026-10-15', { category_id: coffee }); // first day of new period
  await t.spend('Cafe', 3, '2026-11-14', { category_id: coffee }); // last day of this period
  await t.spend('Cafe', 99, '2026-11-15', { category_id: coffee }); // next period
  const s = (await t.call('GET', '/api/categories')).categories.find((c) => c.id === coffee).status;
  assert.equal(s.period_start, '2026-10-15');
  assert.equal(s.period_end, '2026-11-14');
  assert.equal(s.resets_on, '2026-11-15');
  assert.equal(s.spent_cents, 1000);
});

test('archived categories keep history but drop out of budgets and rules', async () => {
  const t = makeApp();
  const coffee = t.cat('coffee');
  await t.call('PUT', `/api/categories/${coffee}/budget`, { amount_cents: 5000, period: 'monthly' });
  await t.call('POST', '/api/rules', { match_type: 'contains', pattern: 'starbucks', category_id: coffee });
  await t.call('PATCH', `/api/categories/${coffee}`, { archived: true });
  const d = await t.call('GET', '/api/dashboard?month=2026-10');
  assert.equal(d.budgets.find((b) => b.category_id === coffee), undefined);
  const tx = await t.spend('Starbucks', 5, '2026-10-12');
  assert.equal(tx.transaction.category_id, null);
});
