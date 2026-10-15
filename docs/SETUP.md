# Setting up your budget app for real use

This guide takes the app from "runs on a computer" to "on my iPhone, synced with my banks, sending alerts". Nothing here asks you to share a password or key with anyone; every secret goes into the server's own `.env` file.

What you'll end up with:

| Piece | Cost | Notes |
|---|---|---|
| The app server (Node + SQLite) | $0 | Runs on a computer you already own, or a free cloud VM |
| Public HTTPS address | $0 | Tailscale Funnel gives you `https://<name>.<tailnet>.ts.net` |
| Plaid Sandbox (test banks) | $0 | Unlimited, fake data only |
| Plaid Trial plan (real banks) | $0 | Up to 10 bank connections ("Items"), see limits below |
| Web push to iPhone | $0 | Uses Apple's push service through standard Web Push |

The only way this costs money is if you need more than 10 Plaid connections (then Plaid's paid plan applies; Plaid shows its prices when you request a paid plan) or choose paid hosting or a custom domain.

---

## 1. Run the server somewhere that stays on

Push alerts and bank syncs happen on the server, so it has to be running when you're not using the app.

**Recommended ($0): a computer at home that stays on** (Mac mini, old laptop, Raspberry Pi 4/5, a Windows PC with WSL).

1. Install Node.js 22.13 or later (or Docker).
2. Copy the `budgeting-app` folder onto it.
3. In that folder:
   ```sh
   npm install
   npm run build
   cp .env.example .env      # then edit .env (steps below)
   npm start
   ```
   Or with Docker: `docker compose up -d --build`.
4. The first start prints a line like `First-time setup code: 3F9A12CD`. Keep the window open; you'll need that code once.

**Alternative ($0, more setup): Oracle Cloud Always Free VM.** Oracle's Always Free Arm shape (reduced to 2 OCPU / 12 GB in August 2026, still far more than this app needs) works well with the Docker setup above. It requires a credit card for identity verification, and free Arm capacity is sometimes unavailable in a region.

Avoid free tiers that sleep or wipe disks (for example Render's free web services): sleeping servers miss scheduled syncs and alerts, and a wiped disk loses your data.

## 2. Give it a private HTTPS address

iPhone notifications, secure sign-in cookies and Plaid webhooks all require HTTPS.

**Tailscale Funnel** (free on the Personal plan):

1. Install Tailscale on the server computer and sign in: <https://tailscale.com/download>.
2. In the Tailscale admin console, enable **HTTPS certificates** and **Funnel** for your tailnet (Access controls → Funnel).
3. On the server run: `tailscale funnel --bg 8080`
4. Tailscale prints your address, e.g. `https://budget-box.tail1234.ts.net`.
5. Put it in `.env`:
   ```
   PUBLIC_URL=https://budget-box.tail1234.ts.net
   ```
6. Restart the app (`npm start` again, or `docker compose up -d`).

The address is reachable from the internet, which is what Plaid and Apple need. The app itself is locked behind your login: one owner account, scrypt-hashed password, 30-day sessions in HttpOnly cookies, CSRF protection, and rate-limited sign-in.

## 3. Create your login

1. Open your `PUBLIC_URL` in Safari.
2. Enter the setup code from the server log, a username, and a password of 10+ characters.
3. You're in. Categories are pre-filled; edit or archive any of them under **Budgets**.

## 4. Install it on your iPhone

1. In Safari, open your `PUBLIC_URL` and sign in.
2. Tap **Share** → **Add to Home Screen** → keep **Open as Web App** on → **Add**.
3. Open **Budget** from the Home Screen (not from Safari) from now on.

## 5. Turn on notifications

1. Add a real contact address to `.env` and restart. Apple rejects pushes without one:
   ```
   VAPID_SUBJECT=mailto:you@example.com
   ```
2. In the Home Screen app: **More → Alerts & notifications → Turn on notifications → Allow**.
3. Tap **Send test notification**, lock the phone, and confirm it arrives.

Requirements and behavior:
- iOS/iPadOS 16.4 or later, and only from the Home Screen app.
- Alerts arrive while the app is closed. Focus modes and Notification Summary can delay or silence them (Settings → Notifications → Budget).
- Each budget alerts at 80% and 100% by default (editable), once per threshold per budget period. A refund that drops you below a threshold doesn't re-arm it until the period resets.
- Alerts come after your bank reports a purchase, which can take hours or sometimes a day or more. They can't block a purchase.

## 6. Connect banks with Plaid

### 6a. Sandbox first (free, fake data)

1. Create a Plaid account at <https://dashboard.plaid.com/signup>. US developers who sign up on or after April 15, 2026 land on the free **Trial** plan automatically.
2. Go to **Developers → Keys**. Copy the `client_id` and the **Sandbox** secret into `.env` on the server:
   ```
   PLAID_ENV=sandbox
   PLAID_CLIENT_ID=...
   PLAID_SECRET=...
   ```
3. Restart. **Accounts** now shows **Connect a bank** and **Add Sandbox test bank**.
4. Tap **Add Sandbox test bank** for a one-tap test (it uses Plaid's `user_transactions_dynamic` test user, which produces pending→posted updates). Or use **Connect a bank**, pick any institution, and sign in with `user_good` / `pass_good`.
5. Everything from Sandbox is labeled **Sandbox test data**. Disconnect it before going live if you don't want it in your history (Disconnect → "delete its data").

### 6b. Real accounts (Trial plan, free up to 10)

What Plaid's Trial plan gives you, as of October 2026 (from Plaid's support articles "What is the Plaid Trial plan" and "How are Sandbox, Production, Trial plan, and Limited Production different"):
- Real production data at no cost, with Transactions included.
- Up to **10 Items**. An Item is one login at one bank, which may include several accounts (checking + savings + card at the same bank = 1 Item).
- **Removing an Item does not free its slot**, and linking the same bank twice counts twice. The app refuses to link accounts you've already connected, before any token is created.
- Almost all OAuth banks (Chase, Bank of America, Wells Fargo, Capital One, Citi, etc.) work without the extra registration paid plans need.
- No business registration or security questionnaire; you accept Plaid's terms and verify your identity. Most applications are approved automatically; flagged ones hear back in 2–3 business days.
- Only for US/Canada developers with no existing Production or Limited Production access. Upgrading to a paid plan is one-way.
- Plaid describes Trial and Pay-as-you-go as suited to hobbyist use; it doesn't publish a rule against personal use, but it also doesn't explicitly address it.

Steps:
1. In the Plaid Dashboard, request **Production** access on the Trial plan and complete identity verification.
2. Add your redirect URI under **Developers → API → Allowed redirect URIs**: `https://<your PUBLIC_URL>/oauth-return`.
3. Update `.env` with the **Production** secret:
   ```
   PLAID_ENV=production
   PLAID_SECRET=<production secret>
   PLAID_REDIRECT_URI=https://<your PUBLIC_URL>/oauth-return
   ```
4. Restart, then **Accounts → Connect a bank** on your iPhone. Plaid Link opens; some banks send you to their own app or site to approve and then return you here.
5. The first sync can take a few minutes while your bank prepares history (up to 12 months is requested). The app also syncs whenever Plaid sends a webhook (enabled automatically because `PUBLIC_URL` is HTTPS) and every 6 hours as a fallback.

If a bank later needs you to sign in again, its card shows **Needs sign-in** with a **Fix connection** button.

## Data, privacy and backups

- Data lives in `DATA_DIR/budget.sqlite` on your server.
- Bank access tokens are encrypted with AES-256-GCM using `DATA_DIR/encryption.key` (or `APP_ENCRYPTION_KEY`). Plaid keys stay in `.env`. Neither ever reaches the browser.
- The server writes a daily database copy to `DATA_DIR/backups/` and keeps 14 days.
- **More → Backup** downloads a full JSON backup (no bank tokens) and restores it. **Export transactions** downloads a CSV.
- Back up `DATA_DIR` (including `encryption.key`) somewhere off the machine occasionally.
- Budget math is plain code on your server; no AI service is used.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Install first" on the notifications screen | Open the app from the Home Screen icon, not Safari |
| Test notification fails with `BadJwtToken` | Set `VAPID_SUBJECT=mailto:you@...` and restart |
| "Bank sync isn't configured" | `PLAID_CLIENT_ID`/`PLAID_SECRET` missing, or secret doesn't match `PLAID_ENV` |
| `INVALID_API_KEYS` | Using the Sandbox secret with `PLAID_ENV=production` or vice versa |
| Transactions arrive late | Normal for banks; tap **Sync now** on the bank's card to check immediately |
| Forgot the password | Stop the app, delete the `users` and `sessions` rows (`sqlite3 data/budget.sqlite "DELETE FROM sessions; DELETE FROM users;"`), restart, and use the new setup code |
