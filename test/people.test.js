import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import { createTenants } from '../server/tenants.js';
import { SimulatedPlaid } from '../server/core/sim-plaid.js';
import { auth, createSecrets } from '../server/services/node-services.js';

function makeServer() {
  const secrets = createSecrets(crypto.randomBytes(32).toString('base64'));
  const plaid = new SimulatedPlaid({ env: 'sandbox' });
  const archived = [];
  const opened = new Map();
  const app = createTenants({
    ownerDb: openDatabase(':memory:'),
    auth,
    openUserDb: (id) => { const d = openDatabase(':memory:'); opened.set(id, d); return d; },
    archiveUserDb: (id) => archived.push(id),
    build: (db, extra) => createApp({
      db,
      config: { ...(extra.userId ? { userId: extra.userId } : {}) },
      services: { auth, secrets, plaid, log: () => {}, ...(extra.authDb ? { authDb: extra.authDb } : {}), ...(extra.tenants ? { tenants: extra.tenants } : {}) },
    }),
  });
  const raw = (method, path, body, cookie) => app.handle({
    method, path, query: {}, body, rawBody: body ? JSON.stringify(body) : '', headers: { 'x-bb': '1', ...(cookie ? { cookie } : {}) }, ip: '1.1.1.1',
  });
  const login = async (username, password) => {
    const r = await raw('POST', '/api/auth/login', { username, password });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.cookies[0].split(';')[0];
  };
  return { app, raw, login, archived, opened };
}

test('people: each login gets a separate budget, and only the owner manages people', async () => {
  const s = makeServer();
  const setup = await s.raw('POST', '/api/auth/setup', { username: 'rod', password: 'correct horse battery' });
  assert.equal(setup.status, 200);
  const rod = setup.cookies[0].split(';')[0];

  // Owner adds a person.
  const add = await s.raw('POST', '/api/people', { username: 'Ana', password: 'another long password' }, rod);
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.deepEqual(add.body.people.map((p) => [p.username, p.is_owner]), [['rod', true], ['Ana', false]]);
  assert.equal((await s.raw('POST', '/api/people', { username: 'ana', password: 'another long password' }, rod)).status, 400, 'usernames are case-insensitive');

  const ana = await s.login('ana', 'another long password'); // case-insensitive sign-in

  // Each person writes to their own budget.
  const t1 = await s.raw('POST', '/api/transactions', { merchant: 'Rod coffee', amount_cents: -500, date: '2026-10-14' }, rod);
  assert.equal(t1.status, 200);
  const t2 = await s.raw('POST', '/api/transactions', { merchant: 'Ana books', amount_cents: -2500, date: '2026-10-14' }, ana);
  assert.equal(t2.status, 200);
  const list = async (cookie) => (await s.raw('GET', '/api/transactions', null, cookie)).body.transactions.map((t) => t.merchant);
  assert.deepEqual(await list(rod), ['Rod coffee']);
  assert.deepEqual(await list(ana), ['Ana books']);

  // Bootstrap tells the UI who is the owner.
  assert.equal((await s.raw('GET', '/api/bootstrap', null, rod)).body.user.is_owner, true);
  const anaBoot = (await s.raw('GET', '/api/bootstrap', null, ana)).body;
  assert.equal(anaBoot.user.is_owner, false);
  assert.equal(anaBoot.user.username, 'Ana');

  // Only the owner manages people.
  assert.equal((await s.raw('GET', '/api/people', null, ana)).status, 403);
  assert.equal((await s.raw('POST', '/api/people', { username: 'x', password: 'long enough pw' }, ana)).status, 403);

  // A person can change their own password; it only signs them out.
  const pw = await s.raw('POST', '/api/auth/password', { current: 'another long password', next: 'brand new password!' }, ana);
  assert.equal(pw.status, 200);
  assert.equal((await s.raw('GET', '/api/bootstrap', null, ana)).status, 401);
  assert.equal((await s.raw('GET', '/api/bootstrap', null, rod)).status, 200);
  const ana2 = await s.login('Ana', 'brand new password!');
  assert.deepEqual(await list(ana2), ['Ana books'], 'data survives a password change');

  // Removing a person signs them out and archives their budget; the owner's data is untouched.
  const anaId = add.body.people.find((p) => p.username === 'Ana').id;
  assert.equal((await s.raw('DELETE', `/api/people/${anaId}`, null, rod)).status, 200);
  assert.deepEqual(s.archived, [anaId]);
  assert.equal((await s.raw('GET', '/api/bootstrap', null, ana2)).status, 401);
  assert.deepEqual(await list(rod), ['Rod coffee']);
  const ownerId = add.body.people.find((p) => p.is_owner).id;
  assert.equal((await s.raw('DELETE', `/api/people/${ownerId}`, null, rod)).status, 400, 'owner cannot remove themselves');
});

test('people: Plaid webhooks reach the budget that owns the bank connection', async () => {
  const s = makeServer();
  const rod = (await s.raw('POST', '/api/auth/setup', { username: 'rod', password: 'correct horse battery' })).cookies[0].split(';')[0];
  await s.raw('POST', '/api/people', { username: 'ana', password: 'another long password' }, rod);
  const ana = await s.login('ana', 'another long password');
  const r = await s.raw('POST', '/api/plaid/sandbox-item', {}, ana);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const anaDb = [...s.opened.values()][0];
  const item = anaDb.get('SELECT item_id FROM plaid_items');
  assert.ok(item, "the bank lives in Ana's budget");
  const ownerHas = (await s.raw('GET', '/api/bootstrap', null, rod)).body.items.length;
  assert.equal(ownerHas, 0, "Rod's budget has no banks");
  // tick runs every budget without throwing
  await s.app.tick();
  await s.app.idle();
});
