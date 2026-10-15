// SQLite schema shared by the Node server (node:sqlite) and the in-browser preview (sql.js).
// Amounts are integer cents. Positive = money in, negative = money out.

export const SCHEMA_VERSION = 1;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, user_agent TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense','income','transfer')),
  icon TEXT, color TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, system_key TEXT, created_at TEXT
);

CREATE TABLE IF NOT EXISTS budgets (
  category_id INTEGER PRIMARY KEY REFERENCES categories(id),
  amount_cents INTEGER NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('weekly','biweekly','monthly')),
  reset_day INTEGER, reset_weekday INTEGER, anchor_date TEXT,
  alerts_enabled INTEGER NOT NULL DEFAULT 1, is_sample INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS plaid_items (
  id INTEGER PRIMARY KEY, item_id TEXT UNIQUE NOT NULL, access_token_enc TEXT NOT NULL,
  institution_id TEXT, institution_name TEXT, environment TEXT NOT NULL,
  cursor TEXT, status TEXT NOT NULL DEFAULT 'ok', last_error TEXT,
  last_attempt_at TEXT, last_success_at TEXT, created_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'depository',
  subtype TEXT, mask TEXT, institution TEXT, source TEXT NOT NULL DEFAULT 'manual',
  plaid_item_id INTEGER REFERENCES plaid_items(id), plaid_account_id TEXT UNIQUE,
  current_balance_cents INTEGER, available_balance_cents INTEGER, currency TEXT DEFAULT 'USD',
  is_sample INTEGER NOT NULL DEFAULT 0, is_sandbox INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id),
  date TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  merchant TEXT, original_name TEXT, category_id INTEGER REFERENCES categories(id),
  notes TEXT, pending INTEGER NOT NULL DEFAULT 0, excluded INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual', plaid_transaction_id TEXT UNIQUE, plaid_category TEXT,
  category_locked INTEGER NOT NULL DEFAULT 0, merchant_locked INTEGER NOT NULL DEFAULT 0,
  is_sample INTEGER NOT NULL DEFAULT 0, is_sandbox INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS tx_cat_date ON transactions(category_id, date);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  match_type TEXT NOT NULL CHECK (match_type IN ('contains','equals','starts_with')),
  pattern TEXT NOT NULL, category_id INTEGER REFERENCES categories(id), rename_to TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT
);

CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL, period_start TEXT NOT NULL,
  period_end TEXT NOT NULL, threshold INTEGER NOT NULL, spent_cents INTEGER NOT NULL,
  budget_cents INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0,
  title TEXT, body TEXT, push_result TEXT, created_at TEXT NOT NULL, read_at TEXT,
  UNIQUE (category_id, period_start, threshold)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  label TEXT, created_at TEXT, last_success_at TEXT, last_error TEXT
);
`;

export function migrate(db) {
  db.exec(SCHEMA);
  db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
}
