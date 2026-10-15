// Node HTTP server: static PWA files + the JSON API in app.js + background jobs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { createTenants } from './tenants.js';
import { auth, createPlaidClient, createPush, createSecrets, generateVapidKeys } from './services/node-services.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;
const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');
const PORT = Number(env.PORT || 8080);
const HOST = env.HOST || '0.0.0.0';
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/$/, '');
const log = (...a) => console.log(new Date().toISOString(), ...a.map((x) => (x instanceof Error ? x.stack : x)));

fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });
const db = openDatabase(path.join(DATA_DIR, 'budget.sqlite'));

// Encryption key for bank access tokens. Prefer an env var; otherwise keep a key file
// beside (not inside) the database so a copied database alone can't reveal tokens.
const keyFile = path.join(DATA_DIR, 'encryption.key');
let encKey = env.APP_ENCRYPTION_KEY;
if (!encKey) {
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  encKey = fs.readFileSync(keyFile, 'utf8').trim();
}
const secrets = createSecrets(encKey);

// One-time setup code so nobody else can claim the app before you do.
let setupCode = env.SETUP_CODE || null;
if (!db.get('SELECT 1 x FROM users LIMIT 1') && !setupCode) {
  setupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  log(`\n\n  First-time setup code: ${setupCode}\n  Open the app and enter this code to create your login.\n`);
}

// Plaid (optional until keys are provided).
const plaidEnv = (env.PLAID_ENV || 'sandbox').toLowerCase();
const plaid = createPlaidClient({ clientId: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, env: plaidEnv, baseUrl: env.PLAID_BASE_URL, clientName: env.APP_NAME || 'Budget' });

// Web push: VAPID keys from env, or generated once and stored in the database.
let vapid = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY } : null;
if (!vapid) {
  const row = db.get("SELECT value FROM meta WHERE key = 'vapid'");
  if (row) vapid = JSON.parse(secrets.decrypt(row.value));
  else {
    vapid = generateVapidKeys();
    db.run("INSERT INTO meta (key, value) VALUES ('vapid', ?)", [secrets.encrypt(JSON.stringify(vapid))]);
  }
}
const vapidSubject = env.VAPID_SUBJECT || (PUBLIC_URL.startsWith('https://') ? PUBLIC_URL : 'mailto:budget-owner@example.com');
const push = env.PUSH_DISABLED === '1' ? null : createPush({ ...vapid, subject: vapidSubject });

const baseConfig = {
  publicUrl: PUBLIC_URL || null,
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : PUBLIC_URL.startsWith('https://'),
  setupCode,
  plaidRedirectUri: env.PLAID_REDIRECT_URI || null,
  vapidSubjectSet: !!env.VAPID_SUBJECT,
};
// Your budget lives in budget.sqlite (with every login); each person you add gets people/user-<id>.sqlite.
const PEOPLE_DIR = path.join(DATA_DIR, 'people');
fs.mkdirSync(PEOPLE_DIR, { recursive: true });
const app = createTenants({
  ownerDb: db,
  auth,
  openUserDb: (id) => openDatabase(path.join(PEOPLE_DIR, `user-${id}.sqlite`)),
  archiveUserDb: (id, udb) => {
    udb.close();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const ext of ['', '-wal', '-shm']) {
      const f = path.join(PEOPLE_DIR, `user-${id}.sqlite${ext}`);
      if (fs.existsSync(f)) fs.renameSync(f, path.join(DATA_DIR, 'backups', `removed-user-${id}-${stamp}.sqlite${ext}`));
    }
    log(`removed person ${id}; their data was moved to backups/`);
  },
  build: (bdb, extra) => createApp({
    db: bdb,
    config: { ...baseConfig, ...(extra.userId ? { userId: extra.userId } : {}) },
    services: { auth, secrets, plaid, push, log, ...(extra.authDb ? { authDb: extra.authDb } : {}), ...(extra.tenants ? { tenants: extra.tenants } : {}) },
  }),
});

// ---------------------------------------------------------------- static files
const WEB = path.join(ROOT, 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const CSP = [
  "default-src 'self'", "script-src 'self' https://cdn.plaid.com", "frame-src https://cdn.plaid.com",
  "connect-src 'self' https://*.plaid.com", "img-src 'self' data:", "style-src 'self' 'unsafe-inline'",
  "worker-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'content-security-policy': CSP,
  ...(PUBLIC_URL.startsWith('https://') ? { 'strict-transport-security': 'max-age=31536000' } : {}),
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '/oauth-return' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(WEB, rel));
  if (!file.startsWith(WEB) || rel.includes('/src/')) return send(res, 404, { 'content-type': 'text/plain' }, 'Not found');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { 'content-type': 'text/plain' }, 'Not found');
    const ext = path.extname(file);
    const cache = ext === '.html' || rel === '/sw.js' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=3600';
    send(res, 200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': cache }, buf);
  });
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const MAX_BODY = 20 * 1024 * 1024;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, {}, '');
    return serveStatic(req, res, url.pathname);
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) return send(res, 413, { 'content-type': 'application/json' }, '{"error":"too_large"}');
    chunks.push(c);
  }
  const rawBody = Buffer.concat(chunks).toString('utf8');
  let body = null;
  if (rawBody) {
    try { body = JSON.parse(rawBody); } catch { return send(res, 400, { 'content-type': 'application/json' }, '{"error":"invalid_json"}'); }
  }
  const ip = env.TRUST_PROXY === '1' ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
  const out = await app.handle({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, rawBody, ip });
  const headers = { 'cache-control': 'no-store', ...out.headers };
  if (out.cookies?.length) headers['set-cookie'] = out.cookies;
  if (typeof out.body === 'string') send(res, out.status, headers, out.body);
  else send(res, out.status, { 'content-type': 'application/json', ...headers }, JSON.stringify(out.body));
});

// ---------------------------------------------------------------- background jobs
function dailyBackup() {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(DATA_DIR, 'backups');
  for (const { name, db: bdb } of app.databases()) {
    const file = path.join(dir, `${name}-${day}.sqlite`);
    if (fs.existsSync(file)) continue;
    try {
      bdb.backupTo(file);
      // Keep the latest 14 daily copies per database.
      const old = fs.readdirSync(dir).filter((f) => new RegExp(`^${name}-\\d{4}-\\d{2}-\\d{2}\\.sqlite$`).test(f)).sort().slice(0, -14);
      for (const f of old) fs.unlinkSync(path.join(dir, f));
      log(`backup written: ${file}`);
    } catch (e) { log('backup failed', name, e); }
  }
}
async function jobs() {
  try { await app.tick(); } catch (e) { log('tick failed', e); }
  dailyBackup();
}
setInterval(jobs, 15 * 60e3).unref();
setTimeout(jobs, 5000).unref();

server.listen(PORT, HOST, () => {
  log(`Budget app listening on http://${HOST}:${PORT}${PUBLIC_URL ? ` (public URL ${PUBLIC_URL})` : ''}`);
  log(`Plaid: ${plaid.configured ? `configured (${plaidEnv})` : 'not configured — bank connections disabled'}; push: ${push ? 'enabled' : 'disabled'}${env.VAPID_SUBJECT ? '' : ' (set VAPID_SUBJECT for iPhone delivery)'}`);
});

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); for (const d of app.databases()) d.db.close(); process.exit(0); });
