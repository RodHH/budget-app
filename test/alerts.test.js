import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';

async function withBudget(opts = {}) {
  const t = makeApp(opts);
  const g = t.cat('groceries');
  await t.call('PUT', `/api/categories/${g}/budget`, { amount_cents: 50000, period: 'monthly' });
  await t.call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } } });
  return { t, g };
}
const events = (t) => t.db.all('SELECT threshold, period_start, notified, push_result FROM alert_events ORDER BY id');

test('80% and 100% each fire once per period, with the reset date in the message', async () => {
  const { t, g } = await withBudget();
  await t.spend('Store', 350, '2026-10-05', { category_id: g }); // 70%
  await t.app.idle();
  assert.equal(t.sent.length, 0);
  await t.spend('Store', 60, '2026-10-06', { category_id: g }); // 82%
  await t.app.idle();
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].title, /Groceries: 80% used/);
  assert.match(t.sent[0].body, /\$410 of \$500 spent/);
  assert.match(t.sent[0].body, /Resets Sun, Nov 1/);
  await t.spend('Store', 10, '2026-10-07', { category_id: g }); // 84%: no repeat
  await t.app.idle();
  assert.equal(t.sent.length, 1);
  await t.spend('Store', 100, '2026-10-08', { category_id: g }); // 104%
  await t.app.idle();
  assert.equal(t.sent.length, 2);
  assert.match(t.sent[1].title, /budget exceeded/);
  assert.match(t.sent[1].body, /Over by \$20/);
  assert.deepEqual(events(t).map((e) => e.threshold), [80, 100]);
});

test('a refund dipping below a threshold does not re-arm it in the same period', async () => {
  const { t, g } = await withBudget();
  await t.spend('Store', 420, '2026-10-05', { category_id: g }); // 84%
  await t.call('POST', '/api/transactions', { merchant: 'Store refund', amount_cents: 10000, date: '2026-10-06', category_id: g }); // 64%
  await t.spend('Store', 100, '2026-10-07', { category_id: g }); // 84% again
  await t.app.idle();
  assert.equal(t.sent.length, 1);
});

test('re-evaluating many times (syncs, edits, scheduler ticks) never duplicates', async () => {
  const { t, g } = await withBudget();
  await t.spend('Store', 450, '2026-10-05', { category_id: g });
  for (let i = 0; i < 5; i++) { t.app.checkAlerts(); await t.app.tick(); }
  await t.app.idle();
  assert.equal(t.sent.length, 1);
  assert.equal(events(t).length, 1);
});

test('jumping straight past 100% sends one notification but records both thresholds', async () => {
  const { t, g } = await withBudget();
  await t.spend('Big shop', 600, '2026-10-05', { category_id: g });
  await t.app.idle();
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].title, /budget exceeded/);
  const e = events(t);
  assert.deepEqual(e.map((x) => [x.threshold, x.push_result]), [[80, 'folded'], [100, 'sent']]);
});

test('a new period starts fresh and can alert again', async () => {
  const { t, g } = await withBudget();
  await t.spend('Store', 450, '2026-10-05', { category_id: g });
  await t.app.idle();
  t.setToday('2026-11-03');
  await t.spend('Store', 420, '2026-11-02', { category_id: g });
  await t.app.idle();
  assert.equal(t.sent.length, 2);
  assert.deepEqual(events(t).map((e) => e.period_start), ['2026-10-01', '2026-11-01']);
  assert.match(t.sent[1].body, /Resets Tue, Dec 1/);
});

test('weekly budget alerts reset on the chosen weekday', async () => {
  const t = makeApp({ today: '2026-10-18' }); // Sunday
  const c = t.cat('coffee');
  await t.call('PUT', `/api/categories/${c}/budget`, { amount_cents: 2000, period: 'weekly', reset_weekday: 1 });
  await t.spend('Cafe', 17, '2026-10-17', { category_id: c });
  await t.app.idle();
  t.setToday('2026-10-19'); // Monday: new week
  await t.spend('Cafe', 17, '2026-10-19', { category_id: c });
  await t.app.idle();
  const e = t.db.all('SELECT period_start FROM alert_events');
  assert.deepEqual(e.map((x) => x.period_start), ['2026-10-12', '2026-10-19']);
});

test('alerts can be turned off per budget and thresholds are configurable', async () => {
  const { t, g } = await withBudget();
  await t.call('PUT', '/api/settings', { alert_thresholds: [50, 90] });
  await t.spend('Store', 260, '2026-10-05', { category_id: g }); // 52%
  await t.app.idle();
  assert.match(t.sent.at(-1).title, /50% used/);
  await t.call('PUT', `/api/categories/${g}/budget`, { amount_cents: 50000, period: 'monthly', alerts_enabled: false });
  await t.spend('Store', 200, '2026-10-06', { category_id: g }); // 92%
  await t.app.idle();
  assert.equal(t.sent.length, 1);
});

test('without push configured, alerts still appear in the app and say why nothing was sent', async () => {
  const t = makeApp({ push: null });
  const g = t.cat('groceries');
  await t.call('PUT', `/api/categories/${g}/budget`, { amount_cents: 10000, period: 'monthly' });
  await t.spend('Store', 90, '2026-10-05', { category_id: g });
  await t.app.idle();
  const d = await t.call('GET', '/api/dashboard');
  assert.equal(d.alerts.length, 1);
  assert.equal(d.alerts[0].push_result, 'push_not_configured');
});

test('expired push subscriptions are removed', async () => {
  const t = makeApp({ push: { publicKey: 'X', send: async () => ({ ok: false, gone: true }) } });
  await t.call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/old', keys: { p256dh: 'k', auth: 'a' } } });
  const g = t.cat('groceries');
  await t.call('PUT', `/api/categories/${g}/budget`, { amount_cents: 1000, period: 'monthly' });
  await t.spend('Store', 9, '2026-10-05', { category_id: g });
  await t.app.idle();
  assert.equal(t.db.get('SELECT COUNT(*) n FROM push_subscriptions').n, 0);
});
