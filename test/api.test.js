import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { makeApp } from './helpers.js';
import { SimulatedPlaid } from '../server/core/sim-plaid.js';
import { createPlaidClient } from '../server/services/node-services.js';

test('authentication: setup code, sessions, CSRF and origin checks', async () => {
  const t = makeApp({ config: { demo: false, setupCode: 'ABCD1234' } });
  const raw = (method, path, body, headers = {}) => t.app.handle({ method, path, query: {}, body, rawBody: '', headers, ip: '1.2.3.4' });
  assert.equal((await raw('GET', '/api/bootstrap')).status, 401);
  assert.equal((await raw('POST', '/api/auth/setup', { username: 'rod', password: 'correct horse battery' }, { 'x-bb': '1' })).status, 403, 'setup code required');
  assert.equal((await raw('POST', '/api/auth/setup', { username: 'rod', password: 'short', setup_code: 'ABCD1234' }, { 'x-bb': '1' })).status, 400);
  const ok = await raw('POST', '/api/auth/setup', { username: 'rod', password: 'correct horse battery', setup_code: 'ABCD1234' }, { 'x-bb': '1' });
  assert.equal(ok.status, 200);
  const cookie = ok.cookies[0].split(';')[0];
  assert.match(ok.cookies[0], /HttpOnly; SameSite=Lax/);
  assert.equal((await raw('POST', '/api/auth/setup', { username: 'x', password: 'another long pw', setup_code: 'ABCD1234' }, { 'x-bb': '1' })).status, 409, 'only one owner');
  assert.equal((await raw('GET', '/api/bootstrap', null, { cookie })).status, 200);
  // Missing CSRF header
  assert.equal((await raw('POST', '/api/categories', { name: 'Pets' }, { cookie })).status, 403);
  // Cross-site origin
  assert.equal((await raw('POST', '/api/categories', { name: 'Pets' }, { cookie, 'x-bb': '1', origin: 'https://evil.example', host: 'budget.example' })).status, 403);
  assert.equal((await raw('POST', '/api/categories', { name: 'Pets' }, { cookie, 'x-bb': '1', origin: 'https://budget.example', host: 'budget.example' })).status, 200);
  // Wrong password, then logout invalidates the session
  assert.equal((await raw('POST', '/api/auth/login', { username: 'rod', password: 'nope nope nope' }, { 'x-bb': '1' })).status, 401);
  await raw('POST', '/api/auth/logout', {}, { cookie, 'x-bb': '1' });
  assert.equal((await raw('GET', '/api/bootstrap', null, { cookie })).status, 401);
  const login = await raw('POST', '/api/auth/login', { username: 'rod', password: 'correct horse battery' }, { 'x-bb': '1' });
  assert.equal(login.status, 200);
});

test('login attempts are rate limited', async () => {
  const t = makeApp({ config: { demo: false } });
  let last;
  for (let i = 0; i < 12; i++) last = await t.app.handle({ method: 'POST', path: '/api/auth/login', query: {}, body: { username: 'a', password: 'b' }, headers: { 'x-bb': '1' }, ip: '9.9.9.9' });
  assert.equal(last.status, 429);
});

test('categories: create, edit, reorder, archive, unarchive', async () => {
  const t = makeApp();
  const { category } = await t.call('POST', '/api/categories', { name: 'Pets', icon: '🐶', kind: 'expense' });
  await t.call('PATCH', `/api/categories/${category.id}`, { name: 'Pet care' });
  const all = (await t.call('GET', '/api/categories')).categories;
  const ids = all.map((c) => c.id).reverse();
  const re = (await t.call('POST', '/api/categories/reorder', { ids })).categories;
  assert.equal(re[0].id, category.id);
  assert.equal(re[0].name, 'Pet care');
  await t.call('PATCH', `/api/categories/${category.id}`, { archived: true });
  let c = (await t.call('GET', '/api/categories')).categories.find((x) => x.id === category.id);
  assert.equal(c.archived, true);
  await t.call('PATCH', `/api/categories/${category.id}`, { archived: false });
  c = (await t.call('GET', '/api/categories')).categories.find((x) => x.id === category.id);
  assert.equal(c.archived, false);
});

test('budget validation', async () => {
  const t = makeApp();
  const e = (body, cat = t.cat('groceries')) => t.call('PUT', `/api/categories/${cat}/budget`, body, { 'x-expect-error': '1' });
  assert.equal((await e({ amount_cents: 0 })).error, 'invalid_request');
  assert.equal((await e({ amount_cents: 100, period: 'yearly' })).error, 'invalid_request');
  assert.equal((await e({ amount_cents: 100, period: 'monthly', reset_day: 32 })).error, 'invalid_request');
  assert.equal((await e({ amount_cents: 100 }, t.cat('paycheck'))).error, 'invalid_request');
  const ok = await t.call('PUT', `/api/categories/${t.cat('groceries')}/budget`, { amount_cents: 40000, period: 'biweekly', anchor_date: '2026-10-09' });
  assert.equal(ok.category.status.period_start, '2026-10-09');
});

test('search, filter and bulk recategorize', async () => {
  const t = makeApp();
  await t.spend('Starbucks Reserve', 6.5, '2026-10-02');
  await t.spend('Shell', 40, '2026-10-03');
  await t.spend('starbucks', 4.25, '2026-09-29');
  let r = await t.call('GET', '/api/transactions?q=starbucks');
  assert.equal(r.total, 2);
  r = await t.call('GET', '/api/transactions?q=40');
  assert.equal(r.transactions[0].merchant, 'Shell');
  r = await t.call('GET', '/api/transactions?from=2026-10-01&to=2026-10-31&status=uncategorized');
  assert.equal(r.total, 2);
  const ids = (await t.call('GET', '/api/transactions?q=starbucks')).transactions.map((x) => x.id);
  await t.call('POST', '/api/transactions/bulk', { ids, category_id: t.cat('coffee') });
  r = await t.call('GET', `/api/transactions?category=${t.cat('coffee')}`);
  assert.equal(r.total, 2);
  assert.equal(r.sum_cents, -1075);
});

test('rules: create from merchant, apply to existing, respect manual choices', async () => {
  const t = makeApp();
  const a = await t.spend('STARBUCKS #12', 5, '2026-10-02');
  const b = await t.spend('Starbucks', 5, '2026-10-03', { category_id: t.cat('gifts') }); // manually chosen
  const r = await t.call('POST', '/api/rules', { match_type: 'contains', pattern: 'Starbucks', category_id: t.cat('coffee'), rename_to: 'Starbucks', apply_existing: true });
  assert.equal(r.applied, 1);
  const list = (await t.call('GET', '/api/transactions')).transactions;
  assert.equal(list.find((x) => x.id === a.transaction.id).category_id, t.cat('coffee'));
  assert.equal(list.find((x) => x.id === a.transaction.id).merchant, 'Starbucks');
  assert.equal(list.find((x) => x.id === b.transaction.id).category_id, t.cat('gifts'));
  const c = await t.spend('Starbucks Reserve Roastery', 9, '2026-10-04');
  assert.equal(c.transaction.category_id, t.cat('coffee'));
  const eq = await t.call('POST', '/api/rules', { match_type: 'equals', pattern: 'shell', category_id: t.cat('transportation') });
  assert.ok(eq.rule.id);
  assert.equal((await t.spend('Shell', 30, '2026-10-05')).transaction.category_id, t.cat('transportation'));
  assert.equal((await t.spend('Shellfish Shack', 30, '2026-10-05')).transaction.category_id, null);
});

test('bank-owned fields are read-only on synced transactions; manual ones are fully editable', async () => {
  const t = makeApp();
  const m = await t.spend('Cash lunch', 12, '2026-10-02');
  const e = await t.call('PATCH', `/api/transactions/${m.transaction.id}`, { amount_cents: -1500, date: '2026-10-03' });
  assert.equal(e.transaction.amount_cents, -1500);
  t.db.run("UPDATE transactions SET source = 'plaid' WHERE id = ?", [m.transaction.id]);
  const r = await t.call('PATCH', `/api/transactions/${m.transaction.id}`, { amount_cents: -100 }, { 'x-expect-error': '1' });
  assert.equal(r.error, 'invalid_request');
  const del = await t.call('DELETE', `/api/transactions/${m.transaction.id}`, null, { 'x-expect-error': '1' });
  assert.equal(del.error, 'invalid_request');
});

test('backup export → import round trip, and CSV export neutralizes formulas', async () => {
  const t = makeApp();
  await t.call('POST', '/api/sample/load');
  await t.spend('=HYPERLINK("http://x")', 1, '2026-10-02');
  const exp = await t.call('GET', '/api/export/json');
  const data = JSON.parse(exp);
  assert.ok(data.transactions.length > 50);
  const csv = await t.call('GET', '/api/export/csv');
  assert.match(csv, /'=HYPERLINK/);
  const before = await t.call('GET', '/api/dashboard?month=2026-10');
  const t2 = makeApp();
  const r = await t2.call('POST', '/api/import/json', { data });
  assert.equal(r.counts.transactions, data.transactions.length);
  const after = await t2.call('GET', '/api/dashboard?month=2026-10');
  assert.equal(after.spending_cents, before.spending_cents);
  assert.equal(after.income_cents, before.income_cents);
  assert.equal(after.budgets.length, before.budgets.length);
  const bad = await t2.call('POST', '/api/import/json', { data: { hello: 1 } }, { 'x-expect-error': '1' });
  assert.equal(bad.error, 'invalid_request');
});

test('sample data is labeled and removable without touching your own data', async () => {
  const t = makeApp();
  const mine = await t.spend('My real purchase', 20, '2026-10-02');
  await t.call('POST', '/api/sample/load');
  let boot = await t.call('GET', '/api/bootstrap');
  assert.equal(boot.has_sample, true);
  assert.ok((await t.call('GET', '/api/transactions?status=sample')).total > 50);
  await t.call('POST', '/api/sample/remove');
  boot = await t.call('GET', '/api/bootstrap');
  assert.equal(boot.has_sample, false);
  const left = (await t.call('GET', '/api/transactions')).transactions;
  assert.deepEqual(left.map((x) => x.id), [mine.transaction.id]);
  assert.equal(t.db.get('SELECT COUNT(*) n FROM budgets').n, 0);
});

test('real Plaid HTTP client talks to a Plaid-compatible server', async () => {
  const sim = new SimulatedPlaid({ env: 'sandbox' });
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push({ path: req.url, client_id: body.client_id, secret: body.secret });
    const map = {
      '/sandbox/public_token/create': () => sim.sandboxPublicTokenCreate(body),
      '/item/public_token/exchange': async () => { const r = await sim.publicTokenExchange(body.public_token); sim.addAccount(r.access_token, { name: 'Chk', mask: '0001' }); sim.add(r.access_token, { amount: 12.34, date: '2026-10-01', name: 'TEST' }); return r; },
      '/accounts/get': () => sim.accountsGet(body.access_token),
      '/transactions/sync': () => sim.transactionsSync(body),
      '/link/token/create': () => { assert.deepEqual(body.products, ['transactions']); return sim.linkTokenCreate(); },
    };
    try {
      const out = await map[req.url]();
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error_code: e.error_code || 'X', error_message: e.message }));
    }
  });
  await new Promise((r) => server.listen(0, r));
  const client = createPlaidClient({ clientId: 'cid', secret: 'sec', env: 'sandbox', baseUrl: `http://127.0.0.1:${server.address().port}` });
  const t = makeApp({ plaid: client });
  const lt = await t.call('POST', '/api/plaid/link-token', {});
  assert.ok(lt.link_token);
  const r = await t.call('POST', '/api/plaid/sandbox-item');
  assert.equal(r.sync.added, 1);
  assert.equal(t.db.get('SELECT amount_cents FROM transactions').amount_cents, -1234);
  assert.ok(seen.every((s) => s.client_id === 'cid' && s.secret === 'sec'), 'credentials sent server-to-server only');
  // An invalid token surfaces Plaid's error code
  t.db.run("UPDATE plaid_items SET access_token_enc = ?", [t.secrets.encrypt('bad-token')]);
  const bad = await t.call('POST', '/api/plaid/items/1/sync');
  assert.equal(bad.ok, false);
  server.close();
});

test('Plaid webhook signature verification (ES256 JWT + body hash)', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', created_at: 1, expired_at: null };
  const fetchImpl = async (url) => ({ ok: true, json: async () => ({ key: jwk }) });
  const client = createPlaidClient({ clientId: 'a', secret: 'b', env: 'sandbox', fetchImpl });
  const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'x' });
  const sign = (payload, b = body) => {
    const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const s = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await client.verifyWebhook(body, { 'plaid-verification': sign({ iat: now, request_body_sha256: hash }) }), true);
  assert.equal(await client.verifyWebhook(body + ' ', { 'plaid-verification': sign({ iat: now, request_body_sha256: hash }) }), false, 'tampered body');
  assert.equal(await client.verifyWebhook(body, { 'plaid-verification': sign({ iat: now - 3600, request_body_sha256: hash }) }), false, 'stale');
  assert.equal(await client.verifyWebhook(body, {}), false, 'missing header');
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iat: now, request_body_sha256: hash })).toString('base64url');
  const forged = `${h}.${p}.${crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: other, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  assert.equal(await client.verifyWebhook(body, { 'plaid-verification': forged }), false, 'wrong key');
});

test('Plaid features report "not configured" without keys', async () => {
  const t = makeApp({ plaid: createPlaidClient({ env: 'sandbox' }) });
  const r = await t.call('POST', '/api/plaid/link-token', {}, { 'x-expect-error': '1' });
  assert.equal(r.error, 'plaid_not_configured');
  const boot = await t.call('GET', '/api/bootstrap');
  assert.equal(boot.features.plaid.configured, false);
});
