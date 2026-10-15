# Budget

A private, installable budgeting web app: categories and weekly/biweekly/monthly budgets, manual and bank-synced transactions (Plaid), merchant rules, threshold alerts with web push, backup/export. Node 22 + built-in SQLite on the server, Preact PWA in the browser. No AI service and no paid service required.

- **Run locally:** `npm install && npm run build && npm start`, then open http://localhost:8080 and use the setup code printed in the log.
- **Real use (iPhone, banks, notifications):** see [docs/SETUP.md](docs/SETUP.md).
- **Tests:** `npm test` (unit + API tests), `node scripts/smoke.mjs http://localhost:8080 <dir>` (browser smoke test; needs Playwright).
- **Interactive preview:** `npm run demo` builds `demo/dist/preview.html`, which runs the same server code in the browser on SQLite/WASM with a simulated bank.

## Layout

| Path | What |
|---|---|
| `server/app.js` | All API routes; platform-independent (also runs in the preview) |
| `server/core/` | Budget periods, totals, alerts, rules, Plaid sync, schema, sample data, simulated Plaid |
| `server/services/node-services.js` | Password hashing, token encryption, Plaid HTTP client + webhook verification, web push |
| `server/index.js` | HTTP server, static files, security headers, scheduler, daily backups |
| `web/` | PWA: `src/` (Preact), `sw.js` (offline shell + push), manifest, icons |
| `test/` | `node:test` suites |

## How the money math works

Amounts are integer cents; positive is money in. Transfers and credit-card payments live in "transfer" categories and never count as spending or income. Money in on a spending category is a refund and reduces that category. Pending transactions count by default (toggle in Preferences). Excluded and bank-removed transactions never count. Budget periods are computed on calendar dates in your time zone; monthly reset days past a month's end clamp to its last day.
