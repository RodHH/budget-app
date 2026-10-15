// Interactive preview: runs the real server code (server/app.js) inside the browser on
// SQLite compiled to WebAssembly, with a simulated bank instead of Plaid. No network calls.
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import wasm from 'sql.js/dist/sql-wasm.wasm';
import { createApp } from '../server/app.js';
import { migrate } from '../server/core/schema.js';
import { SimulatedPlaid } from '../server/core/sim-plaid.js';
import { loadSample } from '../server/core/sample.js';
import { todayIn } from '../server/core/dates.js';
import { mount } from '../web/src/main.jsx';

const KEY = 'bb-preview-v1';

function sqljsAdapter(raw) {
  let depth = 0;
  const clean = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
  const db = {
    kind: 'sqljs',
    all(sql, params = []) {
      const st = raw.prepare(sql);
      st.bind(clean(params));
      const rows = [];
      while (st.step()) rows.push(st.getAsObject());
      st.free();
      return rows;
    },
    get(sql, params = []) { return db.all(sql, params)[0]; },
    run(sql, params = []) {
      raw.run(sql, clean(params));
      const changes = raw.getRowsModified();
      const id = raw.exec('SELECT last_insert_rowid()')[0].values[0][0];
      return { changes, lastInsertRowid: Number(id) };
    },
    exec(sql) { raw.exec(sql); },
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN');
      try { const out = fn(); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; } finally { depth--; }
    },
  };
  return db;
}

const b64 = {
  enc: (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); },
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

async function start() {
  const SQL = await initSqlJs({ wasmBinary: wasm });
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* storage blocked */ }
  const raw = saved?.db ? new SQL.Database(b64.dec(saved.db)) : new SQL.Database();
  const db = sqljsAdapter(raw);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  const plaid = saved?.plaid ? SimulatedPlaid.fromJSON(saved.plaid, { env: 'simulated' }) : new SimulatedPlaid({ env: 'simulated' });
  const app = createApp({
    db,
    config: { demo: true },
    services: {
      auth: null,
      secrets: { encrypt: (s) => `demo:${s}`, decrypt: (s) => s.replace(/^demo:/, '') },
      plaid,
      push: null,
      log: (...a) => console.debug('[preview]', ...a),
    },
  });
  if (!saved) {
    // First visit: show the labeled sample data so the preview isn't empty.
    loadSample(db, todayIn(app.getSettings().timezone), new Date().toISOString());
  }

  let timer = null;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify({ db: b64.enc(raw.export()), plaid: plaid.toJSON() })); } catch { /* quota or blocked */ }
    }, 300);
  };
  window.__bbResetPreview = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } location.reload(); };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const headers = {};
    new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
    const rawBody = typeof init.body === 'string' ? init.body : '';
    const out = await app.handle({
      method: init.method || 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams),
      headers, body: rawBody ? JSON.parse(rawBody) : null, rawBody, ip: 'preview',
    });
    if ((init.method || 'GET') !== 'GET') persist();
    const isText = typeof out.body === 'string';
    return new Response(isText ? out.body : JSON.stringify(out.body), {
      status: out.status,
      headers: { 'content-type': isText ? (out.headers['content-type'] || 'text/plain') : 'application/json' },
    });
  };
  persist();
  mount(document.getElementById('app'));
}

start().catch((e) => {
  document.getElementById('app').innerHTML = `<div class="auth"><div class="card"><h1>Preview failed to start</h1><p class="muted">${String(e.message || e)}</p></div></div>`;
});
