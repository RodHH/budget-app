import crypto from 'node:crypto';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import { SimulatedPlaid } from '../server/core/sim-plaid.js';
import { auth, createSecrets } from '../server/services/node-services.js';

export function makeApp({ today = '2026-10-14', plaid = new SimulatedPlaid({ env: 'sandbox' }), push = 'fake', config = {} } = {}) {
  const db = openDatabase(':memory:');
  let clock = new Date(`${today}T16:00:00Z`);
  const sent = [];
  const pushSvc = push === 'fake'
    ? { publicKey: 'BFAKE', send: async (sub, payload) => { sent.push({ sub: sub.endpoint, ...payload }); return { ok: true }; } }
    : push;
  const secrets = createSecrets(crypto.randomBytes(32).toString('base64'));
  const app = createApp({
    db, config: { demo: true, ...config }, services: { auth, secrets, plaid, push: pushSvc, log: () => {} }, now: () => clock,
  });
  const call = async (method, path, body, headers = {}) => {
    const [p, qs] = path.split('?');
    const r = await app.handle({
      method, path: p, query: Object.fromEntries(new URLSearchParams(qs || '')), body,
      rawBody: body ? JSON.stringify(body) : '', headers: { 'x-bb': '1', ...headers }, ip: '127.0.0.1',
    });
    if (r.status >= 400 && !headers['x-expect-error']) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return {
    db, app, plaid, secrets, sent, call,
    setToday(d) { clock = new Date(`${d}T16:00:00Z`); },
    cat: (key) => db.get('SELECT id FROM categories WHERE system_key = ?', [key]).id,
    spend: (merchant, dollars, date, extra = {}) => call('POST', '/api/transactions', { merchant, amount_cents: -Math.round(dollars * 100), date, ...extra }),
  };
}
