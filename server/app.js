// HTTP-agnostic application: (request object) -> (response object).
// The Node server (server/index.js) and the in-browser preview (demo/) both run this file.
// It imports only pure modules; anything platform-specific (password hashing, encryption,
// Plaid HTTP, web push) is injected through `services`.
import { evaluateAlerts } from './core/alerts.js';
import { seedCategories } from './core/categories.js';
import { addDays, isValidDate, monthKey, monthRange, shiftMonth, todayIn } from './core/dates.js';
import { PERIODS, describeSchedule, periodFor } from './core/periods.js';
import { MATCH_TYPES, findRule, loadRules, ruleMatches } from './core/rules.js';
import { hasSample, loadSample, removeSample } from './core/sample.js';
import { SCHEMA_VERSION } from './core/schema.js';
import { syncItem, upsertPlaidAccounts } from './core/sync.js';
import { allBudgetStatuses, budgetStatus, dailySpending, summarize } from './core/totals.js';

export class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (msg, code = 'invalid_request') => new HttpError(400, code, msg);
const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);

const DEFAULT_SETTINGS = {
  timezone: 'America/New_York',
  alert_thresholds: [80, 100],
  include_pending: true,
  sync_interval_hours: 6,
};
const SESSION_DAYS = 30;
const PUBLIC_ROUTES = new Set(['GET /api/health', 'GET /api/auth/state', 'POST /api/auth/setup', 'POST /api/auth/login', 'POST /api/plaid/webhook']);

export function createApp({ db, config = {}, services = {}, now = () => new Date() }) {
  const { auth, secrets, plaid = null, push = null, log = () => {} } = services;
  // Logins and sessions live in one shared database (authDb). With several people on one server,
  // each person's budget is a separate database and a separate app instance (see server/tenants.js).
  const adb = services.authDb || db;
  const tenants = services.tenants || null;
  const ownerId = () => adb.get('SELECT MIN(id) id FROM users')?.id ?? null;
  // Which login this budget belongs to: the owner's budget, or config.userId for everyone else.
  const budgetUserId = () => (config.userId ?? ownerId());
  const nowIso = () => now().toISOString();
  const background = new Set();
  const loginAttempts = new Map();
  seedCategories(db, nowIso());

  // ---------------------------------------------------------------- settings
  function getSettings() {
    const row = db.get("SELECT value FROM meta WHERE key = 'settings'");
    return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
  }
  function saveSettings(s) {
    db.run("INSERT INTO meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(s)]);
  }
  const today = () => todayIn(getSettings().timezone, now());
  const totalsOpts = () => ({ includePending: getSettings().include_pending });

  // ---------------------------------------------------------------- alerts + push
  function track(promise) {
    const p = promise.catch((e) => log('background error', e)).finally(() => background.delete(p));
    background.add(p);
    return p;
  }

  async function deliver(notes) {
    const subs = push ? db.all('SELECT * FROM push_subscriptions') : [];
    for (const n of notes) {
      const results = [];
      for (const sub of subs) {
        try {
          const r = await push.send(sub, { title: n.title, body: n.body, url: '/#/budgets', tag: `budget-${n.category_id}`, kind: 'budget' });
          if (r.gone) db.run('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
          else if (r.ok) db.run('UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL WHERE id = ?', [nowIso(), sub.id]);
          else db.run('UPDATE push_subscriptions SET last_error = ? WHERE id = ?', [r.error || 'failed', sub.id]);
          results.push(r.ok ? 'sent' : r.gone ? 'expired' : 'failed');
        } catch (e) {
          results.push('failed');
          db.run('UPDATE push_subscriptions SET last_error = ? WHERE id = ?', [String(e.message || e), sub.id]);
        }
      }
      const summary = !push ? 'push_not_configured' : subs.length ? results.join(',') : 'no_devices';
      db.run('UPDATE alert_events SET notified = 1, push_result = ? WHERE id = ?', [summary, n.id]);
    }
  }

  function checkAlerts() {
    const s = getSettings();
    const notes = evaluateAlerts(db, { asOf: today(), thresholds: s.alert_thresholds, includePending: s.include_pending, now: nowIso() });
    if (notes.length) track(deliver(notes));
    return notes;
  }

  // ---------------------------------------------------------------- auth
  function parseCookies(header = '') {
    const out = {};
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function sessionCookie(token, maxAge) {
    const secure = config.cookieSecure ? '; Secure' : '';
    return `bb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }
  function createSession(userId, ua) {
    const token = auth.randomToken();
    const exp = new Date(now().getTime() + SESSION_DAYS * 864e5).toISOString();
    adb.run('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)', [auth.sha256(token), userId, nowIso(), exp, (ua || '').slice(0, 200)]);
    return sessionCookie(token, SESSION_DAYS * 86400);
  }
  function currentUser(req) {
    if (config.demo) return { id: 0, username: 'preview' };
    const token = parseCookies(req.headers.cookie).bb_session;
    if (!token) return null;
    const s = adb.get('SELECT * FROM sessions WHERE id_hash = ?', [auth.sha256(token)]);
    if (!s || s.expires_at < nowIso()) return null;
    return adb.get('SELECT id, username FROM users WHERE id = ?', [s.user_id]) || null;
  }
  function rateLimit(ip) {
    const t = now().getTime();
    const e = loginAttempts.get(ip);
    if (!e || e.reset < t) { loginAttempts.set(ip, { n: 1, reset: t + 15 * 60e3 }); return; }
    if (++e.n > 10) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again in 15 minutes.');
  }
  function validatePassword(pw) {
    if (typeof pw !== 'string' || pw.length < 10) throw bad('Use a password of at least 10 characters.');
    if (pw.length > 200) throw bad('Password is too long.');
  }

  // ---------------------------------------------------------------- validation helpers
  const str = (v, max, field) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw bad(`${field} must be text.`);
    const s = v.trim();
    if (s.length > max) throw bad(`${field} is too long.`);
    return s;
  };
  const cents = (v, field = 'Amount') => {
    if (!Number.isInteger(v) || Math.abs(v) > 1e11) throw bad(`${field} must be a whole number of cents.`);
    return v;
  };
  const categoryRef = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const c = db.get('SELECT id, archived FROM categories WHERE id = ?', [Number(v)]);
    if (!c) throw bad('Unknown category.');
    return c.id;
  };
  const accountRef = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const a = db.get('SELECT id FROM accounts WHERE id = ?', [Number(v)]);
    if (!a) throw bad('Unknown account.');
    return a.id;
  };

  // ---------------------------------------------------------------- views
  function categoriesView() {
    const t = today();
    const opts = totalsOpts();
    return db.all(
      `SELECT c.*, b.amount_cents, b.period, b.reset_day, b.reset_weekday, b.anchor_date, b.alerts_enabled, b.is_sample AS budget_is_sample,
         (SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id AND t.deleted_at IS NULL) AS txn_count
       FROM categories c LEFT JOIN budgets b ON b.category_id = c.id ORDER BY c.archived, c.sort_order, c.id`,
    ).map((c) => {
      const budget = c.amount_cents != null ? {
        amount_cents: c.amount_cents, period: c.period, reset_day: c.reset_day, reset_weekday: c.reset_weekday,
        anchor_date: c.anchor_date, alerts_enabled: !!c.alerts_enabled, is_sample: !!c.budget_is_sample,
        schedule: describeSchedule(c),
      } : null;
      const status = budget && !c.archived ? budgetStatus(db, { ...c, category_id: c.id }, t, opts) : null;
      return {
        id: c.id, name: c.name, kind: c.kind, icon: c.icon, color: c.color, sort_order: c.sort_order,
        archived: !!c.archived, system_key: c.system_key, txn_count: c.txn_count, budget, status,
      };
    });
  }

  function itemsView() {
    return db.all('SELECT id, item_id, institution_name, environment, status, last_error, last_attempt_at, last_success_at, created_at FROM plaid_items ORDER BY id')
      .map((i) => ({ ...i, accounts: db.all('SELECT id, name, mask, type, subtype, current_balance_cents FROM accounts WHERE plaid_item_id = ?', [i.id]) }));
  }

  function accountsView() {
    return db.all(
      `SELECT a.*, (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id AND t.deleted_at IS NULL) AS txn_count,
              p.environment AS item_environment, p.last_success_at
       FROM accounts a LEFT JOIN plaid_items p ON p.id = a.plaid_item_id ORDER BY a.hidden, a.source DESC, a.id`,
    );
  }

  function featureStatus() {
    const https = (config.publicUrl || '').startsWith('https://');
    return {
      demo: !!config.demo,
      plaid: { configured: !!(plaid && plaid.configured), env: plaid?.env || null, webhook: !!(config.publicUrl && https), redirect_uri: !!config.plaidRedirectUri },
      push: { configured: !!push, public_key: push?.publicKey || null, subject_set: !!config.vapidSubjectSet },
      public_url: config.publicUrl || null,
      https,
    };
  }

  const TXN_SELECT = `SELECT t.*, a.name AS account_name, a.type AS account_type, c.name AS category_name, c.icon AS category_icon,
      c.kind AS category_kind, c.archived AS category_archived
    FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id`;

  function listTransactions(q) {
    const where = ['t.deleted_at IS NULL'];
    const params = [];
    if (q.q) {
      const like = `%${String(q.q).trim().replace(/[%_]/g, '')}%`;
      const parts = ['t.merchant LIKE ?', 't.original_name LIKE ?', 't.notes LIKE ?', 'c.name LIKE ?'];
      params.push(like, like, like, like);
      const num = Number(String(q.q).replace(/[$,]/g, ''));
      if (String(q.q).trim() && !Number.isNaN(num)) { parts.push('ABS(t.amount_cents) = ?'); params.push(Math.round(Math.abs(num) * 100)); }
      where.push(`(${parts.join(' OR ')})`);
    }
    if (q.category === 'uncategorized') where.push('t.category_id IS NULL');
    else if (q.category) { where.push('t.category_id = ?'); params.push(Number(q.category)); }
    if (q.account) { where.push('t.account_id = ?'); params.push(Number(q.account)); }
    if (q.from && isValidDate(q.from)) { where.push('t.date >= ?'); params.push(q.from); }
    if (q.to && isValidDate(q.to)) { where.push('t.date <= ?'); params.push(q.to); }
    const status = {
      pending: 't.pending = 1', uncategorized: 't.category_id IS NULL', excluded: 't.excluded = 1',
      income: "c.kind = 'income'", spending: "(c.kind = 'expense' OR (c.kind IS NULL AND t.amount_cents < 0))",
      transfers: "c.kind = 'transfer'", refunds: "c.kind = 'expense' AND t.amount_cents > 0",
      manual: "t.source = 'manual'", bank: "t.source = 'plaid'", sample: 't.is_sample = 1',
    }[q.status];
    if (status) where.push(status);
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    const w = where.join(' AND ');
    const rows = db.all(`${TXN_SELECT} WHERE ${w} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const agg = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(t.amount_cents),0) AS total FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE ${w}`, params);
    return { transactions: rows.map(txnOut), total: agg.n, sum_cents: agg.total, limit, offset };
  }

  function txnOut(t) {
    return {
      id: t.id, account_id: t.account_id, account_name: t.account_name, account_type: t.account_type, date: t.date,
      amount_cents: t.amount_cents, merchant: t.merchant, original_name: t.original_name, category_id: t.category_id,
      category_name: t.category_name, category_icon: t.category_icon, category_kind: t.category_kind,
      category_archived: !!t.category_archived, notes: t.notes, pending: !!t.pending, excluded: !!t.excluded,
      source: t.source, category_locked: !!t.category_locked, is_sample: !!t.is_sample, is_sandbox: !!t.is_sandbox,
      plaid_category: t.plaid_category, updated_at: t.updated_at,
    };
  }
  const getTxn = (id) => {
    const t = db.get(`${TXN_SELECT} WHERE t.id = ? AND t.deleted_at IS NULL`, [Number(id)]);
    if (!t) throw notFound('Transaction not found.');
    return t;
  };

  function dashboard(q) {
    const t = today();
    const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : monthKey(t);
    const range = monthRange(month);
    const asOf = t < range.start ? range.start : t > range.end ? range.end : t;
    const opts = totalsOpts();
    const cur = summarize(db, range.start, range.end, opts);
    const prevMonth = shiftMonth(month, -1);
    const prevRange = monthRange(prevMonth);
    const prev = summarize(db, prevRange.start, prevRange.end, opts);
    const cumulative = (rows, start, end) => {
      const byDate = new Map(rows.map((r) => [r.date, r.spent_cents]));
      const out = [];
      let total = 0;
      for (let d = start; d <= end; d = addDays(d, 1)) { total += byDate.get(d) || 0; out.push(total); }
      return out;
    };
    const curDaily = cumulative(dailySpending(db, range.start, range.end, opts), range.start, range.end);
    const daysElapsed = asOf >= range.start ? Number(asOf.slice(8, 10)) : 0;
    const cats = new Map(db.all('SELECT id, name, icon, color, kind FROM categories').map((c) => [c.id, c]));
    const budgets = allBudgetStatuses(db, asOf, opts);
    const totalBudget = budgets.reduce((s, b) => s + b.amount_cents, 0);
    const totalSpent = budgets.reduce((s, b) => s + b.spent_cents, 0);
    return {
      today: t, month, range, as_of: asOf, is_current_month: month === monthKey(t),
      income_cents: cur.income_cents, spending_cents: cur.spending_cents, net_cents: cur.net_cents, transfers_cents: cur.transfers_cents,
      previous: { month: prevMonth, income_cents: prev.income_cents, spending_cents: prev.spending_cents },
      by_category: cur.byCategory.map((r) => ({ ...r, ...(r.category_id ? cats.get(r.category_id) : { name: 'Uncategorized', icon: '❔', color: '#858e89' }) })),
      daily: { current: month === monthKey(t) ? curDaily.slice(0, daysElapsed) : curDaily, previous: cumulative(dailySpending(db, prevRange.start, prevRange.end, opts), prevRange.start, prevRange.end) },
      budgets, budget_total_cents: totalBudget, budget_spent_cents: totalSpent, budget_remaining_cents: totalBudget - totalSpent,
      recent: db.all(`${TXN_SELECT} WHERE t.deleted_at IS NULL ORDER BY t.date DESC, t.id DESC LIMIT 6`).map(txnOut),
      counts: {
        uncategorized: db.get('SELECT COUNT(*) n FROM transactions WHERE deleted_at IS NULL AND category_id IS NULL AND date >= ? AND date <= ?', [range.start, range.end]).n,
        pending: db.get('SELECT COUNT(*) n FROM transactions WHERE deleted_at IS NULL AND pending = 1').n,
      },
      alerts: db.all('SELECT a.*, c.name, c.icon FROM alert_events a LEFT JOIN categories c ON c.id = a.category_id WHERE a.read_at IS NULL AND a.push_result IS NOT \'folded\' ORDER BY a.id DESC LIMIT 5'),
      connections: itemsView().map(({ accounts, ...i }) => i),
    };
  }

  // ---------------------------------------------------------------- plaid helpers
  function requirePlaid() {
    if (!plaid || !plaid.configured) throw new HttpError(409, 'plaid_not_configured', 'Bank connections are not configured on the server yet. See the setup guide.');
  }
  async function syncAll(reason) {
    const items = db.all("SELECT * FROM plaid_items WHERE status != 'removed'");
    const results = [];
    for (const it of items) results.push({ id: it.id, ...(await syncItem({ db, plaid, secrets, nowIso }, it)) });
    if (items.length) checkAlerts();
    if (items.length) log(`sync (${reason}): ${JSON.stringify(results)}`);
    return results;
  }
  async function syncOne(id) {
    const it = db.get('SELECT * FROM plaid_items WHERE id = ?', [Number(id)]);
    if (!it) throw notFound('Connection not found.');
    const r = await syncItem({ db, plaid, secrets, nowIso }, it);
    checkAlerts();
    return r;
  }
  async function addItem(publicToken, institution) {
    const ex = await plaid.publicTokenExchange(publicToken);
    let instName = institution?.name || null;
    let instId = institution?.institution_id || null;
    if (!instName) {
      try {
        const info = await plaid.itemGet(ex.access_token);
        instId = info.item.institution_id;
        if (instId) instName = (await plaid.institutionsGetById(instId)).institution.name;
      } catch { /* name is cosmetic */ }
    }
    const env = plaid.env;
    const id = db.run(
      'INSERT INTO plaid_items (item_id, access_token_enc, institution_id, institution_name, environment, created_at) VALUES (?,?,?,?,?,?)',
      [ex.item_id, secrets.encrypt(ex.access_token), instId, instName || 'Bank', env, nowIso()],
    ).lastInsertRowid;
    const item = db.get('SELECT * FROM plaid_items WHERE id = ?', [id]);
    try {
      const acc = await plaid.accountsGet(ex.access_token);
      db.tx(() => upsertPlaidAccounts(db, item, acc.accounts, nowIso()));
    } catch (e) { log('accountsGet failed', e.error_code || e.message); }
    const sync = await syncItem({ db, plaid, secrets, nowIso }, item);
    checkAlerts();
    return { item: itemsView().find((i) => i.id === id), sync };
  }

  async function handleWebhook(req) {
    if (!plaid || !plaid.configured) return { status: 200, body: { ok: true, ignored: true } };
    const ok = await plaid.verifyWebhook(req.rawBody || '', req.headers);
    if (!ok) throw new HttpError(401, 'invalid_signature', 'Webhook signature check failed.');
    const b = req.body || {};
    const item = b.item_id ? db.get('SELECT * FROM plaid_items WHERE item_id = ?', [b.item_id]) : null;
    if (!item) return { status: 200, body: { ok: true, unknown_item: true } };
    const code = `${b.webhook_type}:${b.webhook_code}`;
    if (b.webhook_type === 'TRANSACTIONS' && ['SYNC_UPDATES_AVAILABLE', 'DEFAULT_UPDATE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE'].includes(b.webhook_code)) {
      track(syncItem({ db, plaid, secrets, nowIso }, item).then(() => checkAlerts()));
    } else if (b.webhook_type === 'ITEM' && ['ERROR', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'USER_PERMISSION_REVOKED'].includes(b.webhook_code)) {
      db.run("UPDATE plaid_items SET status = 'login_required', last_error = ? WHERE id = ?", [b.error?.error_code || b.webhook_code, item.id]);
    } else if (b.webhook_type === 'ITEM' && b.webhook_code === 'LOGIN_REPAIRED') {
      db.run("UPDATE plaid_items SET status = 'ok', last_error = NULL WHERE id = ?", [item.id]);
    }
    log(`webhook ${code} for item ${item.id}`);
    return { status: 200, body: { ok: true } };
  }

  // ---------------------------------------------------------------- backup
  const BACKUP_TABLES = ['categories', 'budgets', 'accounts', 'transactions', 'rules', 'alert_events'];
  function exportJson() {
    const data = { app: 'budgeting-app', schema_version: SCHEMA_VERSION, exported_at: nowIso(), settings: getSettings() };
    for (const t of BACKUP_TABLES) data[t] = db.all(`SELECT * FROM ${t} ORDER BY rowid`);
    // Bank access tokens never leave the server; restored bank accounts reconnect on next sync.
    data.accounts = data.accounts.map((a) => ({ ...a, plaid_item_id: null }));
    return data;
  }
  function importJson(data) {
    if (!data || data.app !== 'budgeting-app' || !Array.isArray(data.transactions)) throw bad('That file is not a backup from this app.');
    const cols = {};
    for (const t of BACKUP_TABLES) cols[t] = new Set(db.all(`PRAGMA table_info(${t})`).map((c) => c.name));
    db.tx(() => {
      db.run('PRAGMA defer_foreign_keys = ON');
      for (const t of ['alert_events', 'rules', 'transactions', 'budgets', 'accounts', 'categories']) db.run(`DELETE FROM ${t}`);
      for (const t of BACKUP_TABLES) {
        for (const row of data[t] || []) {
          const keys = Object.keys(row).filter((k) => cols[t].has(k));
          if (!keys.length) continue;
          db.run(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => (typeof row[k] === 'object' && row[k] !== null ? JSON.stringify(row[k]) : row[k])));
        }
      }
      // Re-attach bank accounts to connections that still exist on this server.
      db.run('UPDATE accounts SET plaid_item_id = NULL');
      if (data.settings) saveSettings({ ...getSettings(), ...pickSettings(data.settings) });
    });
    return { ok: true, counts: Object.fromEntries(BACKUP_TABLES.map((t) => [t, (data[t] || []).length])) };
  }
  function pickSettings(s) {
    const out = {};
    if (typeof s.timezone === 'string') out.timezone = s.timezone;
    if (Array.isArray(s.alert_thresholds)) out.alert_thresholds = s.alert_thresholds.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 200).slice(0, 5);
    if (typeof s.include_pending === 'boolean') out.include_pending = s.include_pending;
    if (Number.isInteger(s.sync_interval_hours) && s.sync_interval_hours >= 1 && s.sync_interval_hours <= 24) out.sync_interval_hours = s.sync_interval_hours;
    return out;
  }
  function exportCsv() {
    const rows = db.all(`${TXN_SELECT} WHERE t.deleted_at IS NULL ORDER BY t.date, t.id`);
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s; // neutralize spreadsheet formulas
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const head = ['Date', 'Merchant', 'Original description', 'Amount', 'Category', 'Category type', 'Account', 'Pending', 'Excluded', 'Notes', 'Source'];
    const lines = [head.join(',')];
    for (const t of rows) {
      lines.push([t.date, t.merchant, t.original_name, (t.amount_cents / 100).toFixed(2), t.category_name || 'Uncategorized', t.category_kind || '', t.account_name || '', t.pending ? 'yes' : 'no', t.excluded ? 'yes' : 'no', t.notes, t.source].map(esc).join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  // ---------------------------------------------------------------- routes
  const routes = [];
  const route = (method, pattern, fn) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, pattern, re, keys, fn });
  };

  route('GET', '/api/health', () => ({ ok: true }));

  route('GET', '/api/auth/state', ({ req }) => ({
    setup_required: !config.demo && !adb.get('SELECT 1 x FROM users LIMIT 1'),
    authenticated: !!currentUser(req),
    setup_code_required: !!config.setupCode,
    demo: !!config.demo,
  }));

  route('POST', '/api/auth/setup', ({ req, body }) => {
    if (config.demo) throw bad('Not available in the preview.');
    if (adb.get('SELECT 1 x FROM users LIMIT 1')) throw new HttpError(409, 'already_set_up', 'This app already has an owner. Sign in instead.');
    rateLimit(req.ip);
    if (config.setupCode && body.setup_code !== config.setupCode) throw new HttpError(403, 'bad_setup_code', 'That setup code is not right. It is printed in the server log on first start.');
    const username = str(body.username, 60, 'Username');
    if (!username) throw bad('Choose a username.');
    validatePassword(body.password);
    const id = adb.run('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)', [username, auth.hashPassword(body.password), nowIso()]).lastInsertRowid;
    if (body.timezone && validTz(body.timezone)) saveSettings({ ...getSettings(), timezone: body.timezone });
    return { status: 200, body: { ok: true }, cookies: [createSession(id, req.headers['user-agent'])] };
  });

  route('POST', '/api/auth/login', ({ req, body }) => {
    rateLimit(req.ip);
    const u = adb.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [String(body.username || '').trim()]);
    const ok = u && auth.verifyPassword(String(body.password || ''), u.password_hash);
    if (!ok) throw new HttpError(401, 'bad_credentials', 'Username or password is incorrect.');
    loginAttempts.delete(req.ip);
    adb.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
    return { status: 200, body: { ok: true }, cookies: [createSession(u.id, req.headers['user-agent'])] };
  });

  route('POST', '/api/auth/logout', ({ req }) => {
    const token = parseCookies(req.headers.cookie).bb_session;
    if (token) adb.run('DELETE FROM sessions WHERE id_hash = ?', [auth.sha256(token)]);
    return { status: 200, body: { ok: true }, cookies: [sessionCookie('', 0)] };
  });

  route('POST', '/api/auth/password', ({ user, body }) => {
    if (config.demo) throw bad('Not available in the preview.');
    const u = adb.get('SELECT * FROM users WHERE id = ?', [user.id]);
    if (!auth.verifyPassword(String(body.current || ''), u.password_hash)) throw new HttpError(401, 'bad_credentials', 'Current password is incorrect.');
    validatePassword(body.next);
    adb.run('UPDATE users SET password_hash = ? WHERE id = ?', [auth.hashPassword(body.next), u.id]);
    adb.run('DELETE FROM sessions WHERE user_id = ?', [u.id]);
    return { status: 200, body: { ok: true, signed_out: true }, cookies: [sessionCookie('', 0)] };
  });

  route('GET', '/api/bootstrap', ({ user }) => ({
    user: { username: user.username, is_owner: !config.demo && user.id === ownerId(), people_enabled: !!tenants },
    today: today(),
    settings: getSettings(),
    categories: categoriesView(),
    accounts: accountsView(),
    items: itemsView(),
    features: featureStatus(),
    has_sample: hasSample(db),
    unread_alerts: db.get("SELECT COUNT(*) n FROM alert_events WHERE read_at IS NULL AND push_result IS NOT 'folded'").n,
  }));

  route('GET', '/api/dashboard', ({ query }) => dashboard(query));

  // Categories & budgets
  route('GET', '/api/categories', () => ({ categories: categoriesView() }));
  route('POST', '/api/categories', ({ body }) => {
    const name = str(body.name, 60, 'Name');
    if (!name) throw bad('Give the category a name.');
    const kind = body.kind || 'expense';
    if (!['expense', 'income', 'transfer'].includes(kind)) throw bad('Unknown category type.');
    const max = db.get('SELECT COALESCE(MAX(sort_order), -1) m FROM categories').m;
    const id = db.run('INSERT INTO categories (name, kind, icon, color, sort_order, created_at) VALUES (?,?,?,?,?,?)',
      [name, kind, str(body.icon, 16, 'Icon') || '🏷️', validColor(body.color), max + 1, nowIso()]).lastInsertRowid;
    return { category: categoriesView().find((c) => c.id === id) };
  });
  route('PATCH', '/api/categories/:id', ({ params, body }) => {
    const c = db.get('SELECT * FROM categories WHERE id = ?', [Number(params.id)]);
    if (!c) throw notFound('Category not found.');
    const name = body.name !== undefined ? str(body.name, 60, 'Name') : c.name;
    if (!name) throw bad('Give the category a name.');
    const kind = body.kind ?? c.kind;
    if (!['expense', 'income', 'transfer'].includes(kind)) throw bad('Unknown category type.');
    db.run('UPDATE categories SET name = ?, kind = ?, icon = ?, color = ?, archived = ? WHERE id = ?', [
      name, kind, body.icon !== undefined ? (str(body.icon, 16, 'Icon') || '🏷️') : c.icon,
      body.color !== undefined ? validColor(body.color) : c.color,
      body.archived !== undefined ? (body.archived ? 1 : 0) : c.archived, c.id,
    ]);
    checkAlerts();
    return { category: categoriesView().find((x) => x.id === c.id) };
  });
  route('POST', '/api/categories/reorder', ({ body }) => {
    if (!Array.isArray(body.ids)) throw bad('Send the categories in their new order.');
    db.tx(() => body.ids.forEach((id, i) => db.run('UPDATE categories SET sort_order = ? WHERE id = ?', [i, Number(id)])));
    return { categories: categoriesView() };
  });
  route('PUT', '/api/categories/:id/budget', ({ params, body }) => {
    const c = db.get('SELECT * FROM categories WHERE id = ?', [Number(params.id)]);
    if (!c) throw notFound('Category not found.');
    if (c.kind !== 'expense') throw bad('Budgets can only be set on spending categories.');
    const amount = cents(body.amount_cents, 'Budget amount');
    if (amount <= 0) throw bad('Budget amount must be more than $0.');
    const period = body.period || 'monthly';
    if (!PERIODS.includes(period)) throw bad('Choose weekly, every 2 weeks, or monthly.');
    let resetDay = null; let resetWeekday = null; let anchor = null;
    if (period === 'monthly') {
      resetDay = Number(body.reset_day ?? 1);
      if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31) throw bad('Reset day must be between 1 and 31.');
    } else if (period === 'weekly') {
      resetWeekday = Number(body.reset_weekday ?? 0);
      if (!Number.isInteger(resetWeekday) || resetWeekday < 0 || resetWeekday > 6) throw bad('Pick the day the week starts.');
    } else {
      anchor = body.anchor_date || today();
      if (!isValidDate(anchor)) throw bad('Pick the date a 2-week period starts.');
    }
    db.run(
      `INSERT INTO budgets (category_id, amount_cents, period, reset_day, reset_weekday, anchor_date, alerts_enabled, is_sample, updated_at)
       VALUES (?,?,?,?,?,?,?,0,?) ON CONFLICT(category_id) DO UPDATE SET amount_cents = excluded.amount_cents, period = excluded.period,
       reset_day = excluded.reset_day, reset_weekday = excluded.reset_weekday, anchor_date = excluded.anchor_date,
       alerts_enabled = excluded.alerts_enabled, is_sample = 0, updated_at = excluded.updated_at`,
      [c.id, amount, period, resetDay, resetWeekday, anchor, body.alerts_enabled === false ? 0 : 1, nowIso()],
    );
    checkAlerts();
    return { category: categoriesView().find((x) => x.id === c.id) };
  });
  route('DELETE', '/api/categories/:id/budget', ({ params }) => {
    db.run('DELETE FROM budgets WHERE category_id = ?', [Number(params.id)]);
    return { category: categoriesView().find((x) => x.id === Number(params.id)) };
  });

  // Transactions
  route('GET', '/api/transactions', ({ query }) => listTransactions(query));
  route('GET', '/api/transactions/:id', ({ params }) => ({ transaction: txnOut(getTxn(params.id)) }));
  route('POST', '/api/transactions', ({ body }) => {
    const date = body.date || today();
    if (!isValidDate(date)) throw bad('Pick a valid date.');
    const merchant = str(body.merchant, 120, 'Merchant');
    if (!merchant) throw bad('Add a merchant or description.');
    const amount = cents(body.amount_cents);
    if (amount === 0) throw bad('Amount can’t be $0.');
    let categoryId = categoryRef(body.category_id);
    let locked = categoryId ? 1 : 0;
    if (!categoryId) {
      const rule = findRule(loadRules(db), { merchant, original_name: merchant });
      if (rule) categoryId = rule.category_id;
      locked = 0;
    }
    const id = db.run(
      `INSERT INTO transactions (account_id, date, amount_cents, merchant, original_name, category_id, notes, pending, excluded,
         source, category_locked, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?, 'manual', ?, ?, ?)`,
      [accountRef(body.account_id), date, amount, merchant, merchant, categoryId, str(body.notes, 500, 'Notes'),
        body.pending ? 1 : 0, body.excluded ? 1 : 0, locked, nowIso(), nowIso()],
    ).lastInsertRowid;
    const alerts = checkAlerts();
    return { transaction: txnOut(getTxn(id)), alerts };
  });
  route('PATCH', '/api/transactions/:id', ({ params, body }) => {
    const t = getTxn(params.id);
    const sets = [];
    const vals = [];
    const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
    if (body.merchant !== undefined) {
      const m = str(body.merchant, 120, 'Merchant');
      if (!m) throw bad('Merchant can’t be empty.');
      set('merchant', m); if (t.source !== 'manual') set('merchant_locked', 1);
    }
    if (body.category_id !== undefined) { set('category_id', categoryRef(body.category_id)); set('category_locked', body.category_id ? 1 : 0); }
    if (body.notes !== undefined) set('notes', str(body.notes, 500, 'Notes'));
    if (body.excluded !== undefined) set('excluded', body.excluded ? 1 : 0);
    const bankOwned = ['date', 'amount_cents', 'account_id', 'pending'].filter((k) => body[k] !== undefined);
    if (bankOwned.length && t.source !== 'manual') throw bad('Date, amount and account come from your bank and can’t be edited. You can exclude the transaction instead.');
    if (body.date !== undefined) { if (!isValidDate(body.date)) throw bad('Pick a valid date.'); set('date', body.date); }
    if (body.amount_cents !== undefined) { const a = cents(body.amount_cents); if (a === 0) throw bad('Amount can’t be $0.'); set('amount_cents', a); }
    if (body.account_id !== undefined) set('account_id', accountRef(body.account_id));
    if (body.pending !== undefined) set('pending', body.pending ? 1 : 0);
    if (sets.length) {
      set('updated_at', nowIso());
      db.run(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`, [...vals, t.id]);
    }
    const alerts = checkAlerts();
    return { transaction: txnOut(getTxn(t.id)), alerts };
  });
  route('DELETE', '/api/transactions/:id', ({ params }) => {
    const t = getTxn(params.id);
    if (t.source !== 'manual') throw bad('Bank transactions can’t be deleted (they would come back on the next sync). Exclude it instead.');
    db.run('DELETE FROM transactions WHERE id = ?', [t.id]);
    return { ok: true };
  });
  route('POST', '/api/transactions/bulk', ({ body }) => {
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 1000) throw bad('Select some transactions first.');
    const ids = body.ids.map(Number);
    const ph = ids.map(() => '?').join(',');
    db.tx(() => {
      if (body.category_id !== undefined) {
        const cat = categoryRef(body.category_id);
        db.run(`UPDATE transactions SET category_id = ?, category_locked = ?, updated_at = ? WHERE id IN (${ph})`, [cat, cat ? 1 : 0, nowIso(), ...ids]);
      }
      if (body.excluded !== undefined) db.run(`UPDATE transactions SET excluded = ?, updated_at = ? WHERE id IN (${ph})`, [body.excluded ? 1 : 0, nowIso(), ...ids]);
    });
    const alerts = checkAlerts();
    return { ok: true, updated: ids.length, alerts };
  });

  // Rules
  const rulesView = () => db.all(`SELECT r.*, c.name AS category_name, c.icon AS category_icon, c.archived AS category_archived
    FROM rules r LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.sort_order, r.id`);
  function validRule(body, prev = {}) {
    const match_type = body.match_type ?? prev.match_type ?? 'contains';
    if (!MATCH_TYPES.includes(match_type)) throw bad('Unknown match type.');
    const pattern = body.pattern !== undefined ? str(body.pattern, 120, 'Merchant text') : prev.pattern;
    if (!pattern) throw bad('Enter the merchant text to match.');
    const category_id = body.category_id !== undefined ? categoryRef(body.category_id) : prev.category_id;
    const rename_to = body.rename_to !== undefined ? (str(body.rename_to, 120, 'Rename') || null) : prev.rename_to ?? null;
    if (!category_id && !rename_to) throw bad('Pick a category (or a new merchant name) for this rule.');
    return { match_type, pattern, category_id, rename_to, enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : (prev.enabled ?? 1) };
  }
  function applyRuleToExisting(rule) {
    const cand = db.all('SELECT id, merchant, original_name, category_locked, merchant_locked FROM transactions WHERE deleted_at IS NULL');
    let n = 0;
    db.tx(() => {
      for (const t of cand) {
        if (!ruleMatches(rule, t)) continue;
        if (rule.category_id && !t.category_locked) { db.run('UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?', [rule.category_id, nowIso(), t.id]); n++; }
        if (rule.rename_to && !t.merchant_locked) db.run('UPDATE transactions SET merchant = ? WHERE id = ?', [rule.rename_to, t.id]);
      }
    });
    return n;
  }
  route('GET', '/api/rules', () => ({ rules: rulesView() }));
  route('POST', '/api/rules', ({ body }) => {
    const r = validRule(body);
    const max = db.get('SELECT COALESCE(MAX(sort_order), -1) m FROM rules').m;
    const id = db.run('INSERT INTO rules (match_type, pattern, category_id, rename_to, sort_order, enabled, created_at) VALUES (?,?,?,?,?,?,?)',
      [r.match_type, r.pattern, r.category_id, r.rename_to, max + 1, r.enabled, nowIso()]).lastInsertRowid;
    const applied = body.apply_existing ? applyRuleToExisting({ ...r, id }) : 0;
    if (applied) checkAlerts();
    return { rule: rulesView().find((x) => x.id === id), applied };
  });
  route('PATCH', '/api/rules/:id', ({ params, body }) => {
    const prev = db.get('SELECT * FROM rules WHERE id = ?', [Number(params.id)]);
    if (!prev) throw notFound('Rule not found.');
    const r = validRule(body, prev);
    db.run('UPDATE rules SET match_type = ?, pattern = ?, category_id = ?, rename_to = ?, enabled = ?, is_sample = 0 WHERE id = ?', [r.match_type, r.pattern, r.category_id, r.rename_to, r.enabled, prev.id]);
    const applied = body.apply_existing ? applyRuleToExisting(r) : 0;
    if (applied) checkAlerts();
    return { rule: rulesView().find((x) => x.id === prev.id), applied };
  });
  route('DELETE', '/api/rules/:id', ({ params }) => { db.run('DELETE FROM rules WHERE id = ?', [Number(params.id)]); return { ok: true }; });
  route('POST', '/api/rules/reorder', ({ body }) => {
    if (!Array.isArray(body.ids)) throw bad('Send the rules in their new order.');
    db.tx(() => body.ids.forEach((id, i) => db.run('UPDATE rules SET sort_order = ? WHERE id = ?', [i, Number(id)])));
    return { rules: rulesView() };
  });
  route('POST', '/api/rules/:id/apply', ({ params }) => {
    const r = db.get('SELECT * FROM rules WHERE id = ?', [Number(params.id)]);
    if (!r) throw notFound('Rule not found.');
    const applied = applyRuleToExisting(r);
    checkAlerts();
    return { applied };
  });

  // Accounts
  const ACCOUNT_TYPES = ['depository', 'credit', 'loan', 'investment', 'cash', 'other'];
  route('GET', '/api/accounts', () => ({ accounts: accountsView(), items: itemsView() }));
  route('POST', '/api/accounts', ({ body }) => {
    const name = str(body.name, 60, 'Name');
    if (!name) throw bad('Name the account.');
    const type = body.type || 'depository';
    if (!ACCOUNT_TYPES.includes(type)) throw bad('Unknown account type.');
    const bal = body.current_balance_cents === undefined || body.current_balance_cents === null ? null : cents(body.current_balance_cents, 'Balance');
    const id = db.run("INSERT INTO accounts (name, type, source, institution, current_balance_cents, created_at) VALUES (?,?, 'manual', 'Manual', ?, ?)", [name, type, bal, nowIso()]).lastInsertRowid;
    return { account: accountsView().find((a) => a.id === id) };
  });
  route('PATCH', '/api/accounts/:id', ({ params, body }) => {
    const a = db.get('SELECT * FROM accounts WHERE id = ?', [Number(params.id)]);
    if (!a) throw notFound('Account not found.');
    const name = body.name !== undefined ? str(body.name, 60, 'Name') : a.name;
    if (!name) throw bad('Name the account.');
    let bal = a.current_balance_cents;
    if (body.current_balance_cents !== undefined) {
      if (a.source !== 'manual') throw bad('Bank balances update automatically.');
      bal = body.current_balance_cents === null ? null : cents(body.current_balance_cents, 'Balance');
    }
    db.run('UPDATE accounts SET name = ?, hidden = ?, current_balance_cents = ? WHERE id = ?', [name, body.hidden !== undefined ? (body.hidden ? 1 : 0) : a.hidden, bal, a.id]);
    return { account: accountsView().find((x) => x.id === a.id) };
  });
  route('DELETE', '/api/accounts/:id', ({ params }) => {
    const a = db.get('SELECT * FROM accounts WHERE id = ?', [Number(params.id)]);
    if (!a) throw notFound('Account not found.');
    if (a.plaid_item_id) throw bad('Disconnect the bank first; its accounts are managed by the connection.');
    db.tx(() => {
      db.run('DELETE FROM transactions WHERE account_id = ?', [a.id]);
      db.run('DELETE FROM accounts WHERE id = ?', [a.id]);
    });
    checkAlerts();
    return { ok: true };
  });

  // Plaid
  route('GET', '/api/plaid/status', () => ({ ...featureStatus().plaid, items: itemsView() }));
  route('POST', '/api/plaid/link-token', async ({ body }) => {
    requirePlaid();
    let accessToken;
    if (body.item_id) {
      const it = db.get('SELECT * FROM plaid_items WHERE id = ?', [Number(body.item_id)]);
      if (!it) throw notFound('Connection not found.');
      accessToken = secrets.decrypt(it.access_token_enc);
    }
    const webhook = featureStatus().https ? `${config.publicUrl.replace(/\/$/, '')}/api/plaid/webhook` : undefined;
    const r = await plaid.linkTokenCreate({ access_token: accessToken, webhook, redirect_uri: config.plaidRedirectUri || undefined });
    return { link_token: r.link_token, expiration: r.expiration, env: plaid.env };
  });
  route('POST', '/api/plaid/exchange', async ({ body }) => {
    requirePlaid();
    if (typeof body.public_token !== 'string') throw bad('Missing public token.');
    // Every exchanged token counts toward Plaid's Trial cap of 10 Items, so refuse duplicates up front.
    const instId = body.institution?.institution_id;
    const masks = (body.accounts || []).map((a) => a.mask).filter(Boolean);
    if (instId && masks.length) {
      const dup = db.get(
        `SELECT p.id FROM plaid_items p JOIN accounts a ON a.plaid_item_id = p.id
         WHERE p.institution_id = ? AND a.mask IN (${masks.map(() => '?').join(',')}) LIMIT 1`, [instId, ...masks],
      );
      if (dup) throw new HttpError(409, 'duplicate_item', 'These accounts are already connected. Use “Sync now” or “Fix connection” on the existing bank instead.');
    }
    return addItem(body.public_token, body.institution);
  });
  route('POST', '/api/plaid/sandbox-item', async () => {
    requirePlaid();
    if (plaid.env === 'production') throw bad('Test banks are only available in Sandbox.');
    const r = await plaid.sandboxPublicTokenCreate({ institution_id: 'ins_109508', institution_name: 'First Platypus Bank (test)' });
    if (plaid.env === 'simulated') {
      // Preview only: give the simulated bank some history before the first sync.
      const out = await plaid.publicTokenExchange(r.public_token);
      plaid.seedRealistic(out.access_token, today());
      return addItemFromExchange(out, { name: 'Simulated Platypus Bank', institution_id: 'ins_sim' });
    }
    return addItem(r.public_token, { name: 'First Platypus Bank (Sandbox)', institution_id: 'ins_109508' });
  });
  async function addItemFromExchange(ex, institution) {
    const id = db.run(
      'INSERT INTO plaid_items (item_id, access_token_enc, institution_id, institution_name, environment, created_at) VALUES (?,?,?,?,?,?)',
      [ex.item_id, secrets.encrypt(ex.access_token), institution.institution_id, institution.name, plaid.env, nowIso()],
    ).lastInsertRowid;
    const item = db.get('SELECT * FROM plaid_items WHERE id = ?', [id]);
    const sync = await syncItem({ db, plaid, secrets, nowIso }, item);
    checkAlerts();
    return { item: itemsView().find((i) => i.id === id), sync };
  }
  route('POST', '/api/plaid/items/:id/sync', async ({ params }) => syncOne(params.id));
  route('POST', '/api/plaid/sync-all', async () => ({ results: await syncAll('manual') }));
  route('POST', '/api/plaid/items/:id/simulate', async ({ params }) => {
    if (!plaid || plaid.env !== 'simulated') throw bad('Only available in the preview.');
    const it = db.get('SELECT * FROM plaid_items WHERE id = ?', [Number(params.id)]);
    if (!it) throw notFound('Connection not found.');
    const posted = plaid.simulateNewActivity(secrets.decrypt(it.access_token_enc), today());
    return { posted, sync: await syncOne(it.id) };
  });
  route('DELETE', '/api/plaid/items/:id', async ({ params, query }) => {
    const it = db.get('SELECT * FROM plaid_items WHERE id = ?', [Number(params.id)]);
    if (!it) throw notFound('Connection not found.');
    if (plaid && plaid.configured) {
      try { await plaid.itemRemove(secrets.decrypt(it.access_token_enc)); } catch (e) { log('itemRemove failed', e.error_code || e.message); }
    }
    db.tx(() => {
      if (query.delete_data === '1') {
        db.run('DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id = ?)', [it.id]);
        db.run('DELETE FROM accounts WHERE plaid_item_id = ?', [it.id]);
      } else {
        db.run('UPDATE accounts SET plaid_item_id = NULL WHERE plaid_item_id = ?', [it.id]);
      }
      db.run('DELETE FROM plaid_items WHERE id = ?', [it.id]);
    });
    checkAlerts();
    return { ok: true };
  });
  route('POST', '/api/plaid/webhook', ({ req }) => handleWebhook(req));

  // Alerts & settings
  route('GET', '/api/alerts', () => ({
    alerts: db.all("SELECT a.*, c.name, c.icon FROM alert_events a LEFT JOIN categories c ON c.id = a.category_id WHERE a.push_result IS NOT 'folded' ORDER BY a.id DESC LIMIT 100"),
  }));
  route('POST', '/api/alerts/read-all', () => { db.run('UPDATE alert_events SET read_at = ? WHERE read_at IS NULL', [nowIso()]); return { ok: true }; });
  route('GET', '/api/settings', () => ({ settings: getSettings() }));
  route('PUT', '/api/settings', ({ body }) => {
    const next = { ...getSettings() };
    if (body.timezone !== undefined) { if (!validTz(body.timezone)) throw bad('Unknown time zone.'); next.timezone = body.timezone; }
    if (body.alert_thresholds !== undefined) {
      const t = Array.isArray(body.alert_thresholds) ? [...new Set(body.alert_thresholds.map(Number))] : [];
      if (t.length > 5 || t.some((n) => !Number.isInteger(n) || n < 1 || n > 200)) throw bad('Alert thresholds must be whole percentages between 1 and 200 (up to 5).');
      next.alert_thresholds = t.sort((a, b) => a - b);
    }
    if (body.include_pending !== undefined) next.include_pending = !!body.include_pending;
    if (body.sync_interval_hours !== undefined) {
      const h = Number(body.sync_interval_hours);
      if (!Number.isInteger(h) || h < 1 || h > 24) throw bad('Sync interval must be 1–24 hours.');
      next.sync_interval_hours = h;
    }
    saveSettings(next);
    checkAlerts();
    return { settings: next };
  });

  // Push
  route('GET', '/api/push/status', () => ({ ...featureStatus().push, devices: db.all('SELECT id, label, created_at, last_success_at, last_error FROM push_subscriptions ORDER BY id') }));
  route('POST', '/api/push/subscribe', ({ body }) => {
    if (!push) throw new HttpError(409, 'push_not_configured', 'Push is not configured on the server.');
    const s = body.subscription || {};
    if (typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw bad('Invalid push subscription.');
    db.run(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, last_error = NULL`,
      [s.endpoint, s.keys.p256dh, s.keys.auth, str(body.label, 80, 'Label') || 'This device', nowIso()],
    );
    return { ok: true };
  });
  route('POST', '/api/push/unsubscribe', ({ body }) => {
    if (body.id) db.run('DELETE FROM push_subscriptions WHERE id = ?', [Number(body.id)]);
    else db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [String(body.endpoint || '')]);
    return { ok: true };
  });
  route('POST', '/api/push/test', async () => {
    if (!push) throw new HttpError(409, 'push_not_configured', 'Push is not configured on the server.');
    const subs = db.all('SELECT * FROM push_subscriptions');
    if (!subs.length) throw bad('No devices have notifications turned on yet.');
    const results = [];
    for (const sub of subs) {
      const r = await push.send(sub, { title: 'Test notification', body: 'Notifications are working. Budget alerts will arrive like this, even when the app is closed.', url: '/#/settings', tag: 'test' });
      if (r.gone) db.run('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
      else db.run('UPDATE push_subscriptions SET last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END, last_error = ? WHERE id = ?', [r.ok ? 1 : 0, nowIso(), r.ok ? null : (r.error || 'failed'), sub.id]);
      results.push({ id: sub.id, label: sub.label, ok: r.ok, gone: !!r.gone, error: r.error || null });
    }
    return { results };
  });

  // People (owner only): each person gets their own login and a completely separate budget.
  function requireOwner(user) {
    if (user.id !== ownerId()) throw new HttpError(403, 'owner_only', 'Only the person who set up the app can manage people.');
    if (!tenants) throw bad('Adding people isn’t available here.');
  }
  const peopleView = () => adb.all('SELECT id, username, created_at FROM users ORDER BY id').map((u) => ({ ...u, is_owner: u.id === ownerId() }));
  route('GET', '/api/people', ({ user }) => { requireOwner(user); return { people: peopleView() }; });
  route('POST', '/api/people', ({ user, body }) => {
    requireOwner(user);
    const username = str(body.username, 60, 'Username');
    if (!username) throw bad('Choose a username.');
    if (adb.get('SELECT 1 x FROM users WHERE username = ? COLLATE NOCASE', [username])) throw bad('That username is taken.');
    validatePassword(body.password);
    const id = adb.run('INSERT INTO users (username, password_hash, created_at) VALUES (?,?,?)', [username, auth.hashPassword(body.password), nowIso()]).lastInsertRowid;
    tenants.created(id, { timezone: getSettings().timezone });
    return { people: peopleView() };
  });
  route('DELETE', '/api/people/:id', async ({ user, params }) => {
    requireOwner(user);
    const id = Number(params.id);
    if (id === ownerId()) throw bad('You can’t remove yourself.');
    if (!adb.get('SELECT 1 x FROM users WHERE id = ?', [id])) throw notFound('Person not found.');
    await tenants.removed(id);
    adb.tx(() => {
      adb.run('DELETE FROM sessions WHERE user_id = ?', [id]);
      adb.run('DELETE FROM users WHERE id = ?', [id]);
    });
    return { people: peopleView() };
  });

  /** Disconnects every bank in this budget at Plaid (used when a person is removed). */
  async function disconnectAllBanks() {
    if (!plaid || !plaid.configured) return;
    for (const it of db.all('SELECT * FROM plaid_items')) {
      try { await plaid.itemRemove(secrets.decrypt(it.access_token_enc)); } catch (e) { log('itemRemove failed', e.error_code || e.message); }
    }
  }

  // Backup & sample data
  route('GET', '/api/export/json', () => ({
    status: 200,
    headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="budget-backup-${today()}.json"` },
    body: JSON.stringify(exportJson(), null, 1),
  }));
  route('GET', '/api/export/csv', () => ({
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="transactions-${today()}.csv"` },
    body: exportCsv(),
  }));
  route('POST', '/api/import/json', ({ body }) => {
    const r = importJson(body.data);
    checkAlerts();
    return r;
  });
  route('POST', '/api/sample/load', () => { const r = loadSample(db, today(), nowIso()); checkAlerts(); return r; });
  route('POST', '/api/sample/remove', () => removeSample(db));

  // ---------------------------------------------------------------- dispatcher
  async function handle(req) {
    const method = req.method.toUpperCase();
    const path = req.path.replace(/\/+$/, '') || '/';
    try {
      const match = routes.find((r) => r.method === method && r.re.test(path));
      if (!match) {
        if (routes.some((r) => r.re.test(path))) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
        throw notFound();
      }
      const key = `${method} ${match.pattern}`;
      const isPublic = PUBLIC_ROUTES.has(key);
      if (method !== 'GET' && key !== 'POST /api/plaid/webhook') {
        // CSRF: browsers cannot send this header cross-site without a CORS preflight we never approve.
        if (req.headers['x-bb'] !== '1') throw new HttpError(403, 'csrf', 'Request blocked.');
        const origin = req.headers.origin;
        if (origin && req.headers.host && !config.demo) {
          let host = null;
          try { host = new URL(origin).host; } catch { /* ignore */ }
          const expected = req.headers['x-forwarded-host'] || req.headers.host;
          if (host !== expected) throw new HttpError(403, 'csrf', 'Request blocked.');
        }
      }
      const user = currentUser(req);
      if (!isPublic && !user) throw new HttpError(401, 'unauthenticated', 'Please sign in.');
      // Defense in depth: a session may only reach the budget it owns (auth routes are shared).
      if (user && !config.demo && !path.startsWith('/api/auth/') && user.id !== budgetUserId()) {
        throw new HttpError(403, 'wrong_budget', 'Request blocked.');
      }
      const m = path.match(match.re);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await match.fn({ req, user, params, query: req.query || {}, body: req.body || {} });
      if (out && typeof out.status === 'number' && 'body' in out) return { headers: {}, ...out };
      return { status: 200, headers: {}, body: out };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, headers: {}, body: { error: e.code, message: e.message } };
      if (e.error_code) {
        log('provider error', e.error_code, e.message);
        return { status: 502, headers: {}, body: { error: e.error_code, message: e.display_message || plaidMessage(e.error_code, e.message) } };
      }
      log('unhandled error', e);
      return { status: 500, headers: {}, body: { error: 'server_error', message: 'Something went wrong on the server.' } };
    }
  }

  /** Called periodically by the server: syncs connections that are due and re-checks alerts. */
  async function tick() {
    const s = getSettings();
    const cutoff = new Date(now().getTime() - s.sync_interval_hours * 3600e3).toISOString();
    if (plaid && plaid.configured) {
      const due = db.all("SELECT * FROM plaid_items WHERE status != 'login_required' AND (last_attempt_at IS NULL OR last_attempt_at < ?)", [cutoff]);
      for (const it of due) await syncItem({ db, plaid, secrets, nowIso }, it);
    }
    if (!services.authDb) adb.run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()]);
    checkAlerts();
  }

  return {
    handle, tick, checkAlerts, syncAll, getSettings, saveSettings, disconnectAllBanks, db,
    idle: () => Promise.all([...background]),
  };
}

function validTz(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function validColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#2a78d6';
}

function plaidMessage(code, detail) {
  return {
    ITEM_LOGIN_REQUIRED: 'Your bank needs you to sign in again. Use “Fix connection”.',
    INVALID_API_KEYS: 'The server’s Plaid keys were rejected. Check PLAID_CLIENT_ID and PLAID_SECRET.',
    RATE_LIMIT_EXCEEDED: 'The bank data provider is rate limiting requests. Try again shortly.',
    PRODUCT_NOT_READY: 'Your bank is still preparing transactions. They’ll appear after the next sync.',
  }[code] || `The bank data provider returned an error (${code})${detail ? `: ${detail}` : '.'}`;
}

export { periodFor };
