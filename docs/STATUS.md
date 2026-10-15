# Build status (October 15, 2026)

## Works now
- **Budgets and categories:** create, edit, reorder, archive and restore categories. Weekly (pick the start day), every-2-weeks (pick an anchor date) or monthly (pick a reset day 1–31) limits.
- **Dashboard:** income, spending, net, money left across budgets, per-budget bars with status labels and reset dates, a spending-pace chart against last month, top categories, recent activity.
- **Transactions:** add and edit manual ones, search (merchant, note, category or amount), filter (type, category, account, dates), bulk recategorize or exclude.
- **Merchant rules:** for example "contains Starbucks → Coffee", with optional rename. You can apply a rule to past transactions. A category you pick by hand always wins over a rule.
- **Correct totals:** transfers and credit-card payments are never counted. Refunds reduce their category. Pending charges count until they post (you can turn that off). Excluded and bank-removed transactions don't count.
- **Alerts:** 80% and 100% by default and editable. Each fires once per budget per period, with the reset date in the message. You see them in the app, and as push notifications once push is set up.
- **Plaid integration:** Link (including OAuth return), token exchange on the server, `/transactions/sync` with cursors, multiple banks, last successful sync time, "Fix connection" for banks that need you to sign in again, verified webhooks, a scheduled sync every 6 hours as a fallback, and blocking of duplicate connections.
- **iPhone app:** installable with a home-screen icon, works offline for the app itself, push notifications through a service worker, light and dark mode, 44px+ touch targets.
- **Security:** one owner login (scrypt hashing), a setup code on first run, HttpOnly session cookies, CSRF and origin checks, rate-limited sign-in, Plaid tokens encrypted at rest, and strict security headers.
- **Data:** SQLite on your server, a daily database copy kept for 14 days, a JSON backup you can restore, and a CSV export.
- **Sample data:** optional, labeled "Sample" everywhere, and removable in one tap without touching your own data.

## Tested
- 48 automated tests (`npm test`), all passing. They cover:
  - Budget periods: month and year ends, reset day 31 in February including leap years, mid-month reset days, the weekly start day, the November 1 daylight-saving change, and every-2-weeks before and after the anchor date.
  - Refunds (including one larger than the period's spending), transfers and card payments on both sides, excluded transactions, the pending setting, and uncategorized money in and out.
  - Duplicate imports: replaying a sync after a crash before the cursor was saved.
  - Pagination, including Plaid's "data changed mid-sync" restart.
  - Pending → posted in both orders Plaid can report it, keeping your category, notes and merchant name, and picking up a tip added when the charge posts.
  - Changed and removed bank transactions.
  - Alert deduplication: repeated checks, a refund dropping you under a threshold and back over, jumping past 100% in one purchase, a new period, weekly resets, and alerts turned off.
  - Removal of expired push devices.
  - Encryption and VAPID signing of push payloads for Apple's push service.
  - Webhook signature checks: good signature, tampered body, stale timestamp, wrong key, missing header.
  - Sign-in, setup code, CSRF and origin checks, rate limiting.
  - Backup round trip, and CSV formula neutralization.
- The real Plaid HTTP client was tested against a local Plaid-compatible server.
- Browser smoke tests at iPhone size in light and dark mode (setup, sample data, every screen, adding a transaction, editing a budget): no console errors.

## Not tested from here
- Real Plaid Sandbox calls. Plaid's servers are blocked from my build environment and there are no keys yet.
- Real delivery to an iPhone. That needs your HTTPS address and device.
- The Docker image. Docker isn't available here; the plain `npm start` path was tested.

## Needs your setup (steps in SETUP.md)
1. An always-on computer, or a free VM, running the app.
2. A free Tailscale Funnel HTTPS address → `PUBLIC_URL`.
3. `VAPID_SUBJECT=mailto:you@...` for iPhone push.
4. Plaid Sandbox keys, then Trial plan production keys for real banks (free up to 10 connections).
