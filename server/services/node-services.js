// Node implementations of the services app.js expects: password hashing, token
// encryption at rest, the Plaid HTTP client (with webhook signature verification) and web push.
import crypto from 'node:crypto';
import webpush from 'web-push';

// ---------------------------------------------------------------- passwords & tokens
export const auth = {
  hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
    return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
  },
  verifyPassword(pw, stored) {
    const [scheme, n, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
    return crypto.timingSafeEqual(expected, got);
  },
  randomToken: () => crypto.randomBytes(32).toString('base64url'),
  sha256: (s) => crypto.createHash('sha256').update(s).digest('hex'),
};

// ---------------------------------------------------------------- encryption at rest (AES-256-GCM)
export function createSecrets(keyBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded.');
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
    },
    decrypt(blob) {
      const [v, iv, tag, enc] = String(blob).split('.');
      if (v !== 'v1') throw new Error('Unknown token format');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
    },
  };
}

// ---------------------------------------------------------------- Plaid
const PLAID_HOSTS = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };

export class PlaidError extends Error {
  constructor(data, status) {
    super(data?.error_message || `Plaid HTTP ${status}`);
    this.error_code = data?.error_code || `HTTP_${status}`;
    this.error_type = data?.error_type;
    this.display_message = data?.display_message || null;
    this.status = status;
  }
}

export function createPlaidClient({ clientId, secret, env = 'sandbox', baseUrl, fetchImpl = globalThis.fetch, clientName = 'Budget' }) {
  const configured = !!(clientId && secret && (PLAID_HOSTS[env] || baseUrl));
  const base = baseUrl || PLAID_HOSTS[env];
  const keyCache = new Map();

  async function call(path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'plaid-version': '2020-09-14' },
      body: JSON.stringify({ client_id: clientId, secret, ...body }),
      signal: AbortSignal.timeout(30000),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new PlaidError(data, res.status);
    return data;
  }

  return {
    env,
    configured,
    linkTokenCreate({ access_token, webhook, redirect_uri }) {
      const body = {
        client_name: clientName, language: 'en', country_codes: ['US'], user: { client_user_id: 'owner' },
        ...(webhook ? { webhook } : {}), ...(redirect_uri ? { redirect_uri } : {}),
      };
      if (access_token) body.access_token = access_token; // update mode: re-authenticate an existing Item
      else { body.products = ['transactions']; body.transactions = { days_requested: 365 }; }
      return call('/link/token/create', body);
    },
    publicTokenExchange: (public_token) => call('/item/public_token/exchange', { public_token }),
    accountsGet: (access_token) => call('/accounts/get', { access_token }),
    itemGet: (access_token) => call('/item/get', { access_token }),
    institutionsGetById: (institution_id) => call('/institutions/get_by_id', { institution_id, country_codes: ['US'] }),
    itemRemove: (access_token) => call('/item/remove', { access_token }),
    transactionsSync: ({ access_token, cursor, count }) => call('/transactions/sync', { access_token, ...(cursor ? { cursor } : {}), count }),
    sandboxPublicTokenCreate: ({ institution_id }) => call('/sandbox/public_token/create', {
      institution_id, initial_products: ['transactions'],
      options: { override_username: 'user_transactions_dynamic', override_password: 'pass_good' },
    }),

    /** Verify the Plaid-Verification JWT (ES256) and the body hash it signs. */
    async verifyWebhook(rawBody, headers) {
      const jwt = headers['plaid-verification'];
      if (!jwt || typeof jwt !== 'string') return false;
      const [h64, p64, s64] = jwt.split('.');
      if (!h64 || !p64 || !s64) return false;
      let header; let payload;
      try {
        header = JSON.parse(Buffer.from(h64, 'base64url').toString());
        payload = JSON.parse(Buffer.from(p64, 'base64url').toString());
      } catch { return false; }
      if (header.alg !== 'ES256' || !header.kid) return false;
      let jwk = keyCache.get(header.kid);
      if (!jwk) {
        const r = await call('/webhook_verification_key/get', { key_id: header.kid });
        jwk = r.key;
        keyCache.set(header.kid, jwk);
      }
      if (jwk.expired_at) return false;
      const { alg, created_at, expired_at, ...pub } = jwk;
      const ok = crypto.verify('sha256', Buffer.from(`${h64}.${p64}`), { key: crypto.createPublicKey({ key: pub, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s64, 'base64url'));
      if (!ok) return false;
      if (typeof payload.iat !== 'number' || Math.abs(Date.now() / 1000 - payload.iat) > 300) return false;
      const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
      const claimed = String(payload.request_body_sha256 || '');
      return claimed.length === bodyHash.length && crypto.timingSafeEqual(Buffer.from(claimed), Buffer.from(bodyHash));
    },
  };
}

// ---------------------------------------------------------------- Web push (VAPID)
export function createPush({ publicKey, privateKey, subject, sender = webpush.sendNotification.bind(webpush) }) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return {
    publicKey,
    async send(sub, payload) {
      try {
        await sender({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 24 * 3600, urgency: 'normal', timeout: 10000 });
        return { ok: true };
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) return { ok: false, gone: true };
        return { ok: false, error: `${e.statusCode || ''} ${e.body || e.message}`.trim().slice(0, 200) };
      }
    },
  };
}

export const generateVapidKeys = () => webpush.generateVAPIDKeys();
