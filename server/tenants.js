// Several people on one server, each with a completely separate budget.
//
// The owner's database (budget.sqlite) also holds every login and session. Each additional
// person gets their own database file and their own app instance, so budgets, banks, rules,
// alerts and notification devices never mix. This layer only decides which instance answers.

export function createTenants({ ownerDb, openUserDb, archiveUserDb, build, auth }) {
  const others = new Map(); // userId -> { db, app }
  const hooks = {
    created(id, { timezone } = {}) {
      const t = open(id);
      if (timezone) t.app.saveSettings({ ...t.app.getSettings(), timezone });
    },
    async removed(id) {
      const t = others.get(id) || open(id);
      await t.app.disconnectAllBanks();
      others.delete(id);
      archiveUserDb(id, t.db);
    },
  };
  const owner = build(ownerDb, { tenants: hooks });
  const ownerId = () => ownerDb.get('SELECT MIN(id) id FROM users')?.id ?? null;

  function open(id) {
    let t = others.get(id);
    if (!t) {
      const db = openUserDb(id);
      t = { db, app: build(db, { userId: id, authDb: ownerDb }) };
      others.set(id, t);
    }
    return t;
  }
  // Open every existing person's budget so background syncs and alerts run for all of them.
  for (const u of ownerDb.all('SELECT id FROM users ORDER BY id')) if (u.id !== ownerId()) open(u.id);

  function sessionUserId(req) {
    const m = /(?:^|;\s*)bb_session=([^;]+)/.exec(req.headers?.cookie || '');
    if (!m) return null;
    const s = ownerDb.get('SELECT user_id, expires_at FROM sessions WHERE id_hash = ?', [auth.sha256(decodeURIComponent(m[1]))]);
    return s && s.expires_at >= new Date().toISOString() ? s.user_id : null;
  }

  function appFor(req) {
    const path = req.path || '';
    if (path.startsWith('/api/auth/') || path === '/api/health') return owner;
    if (path === '/api/plaid/webhook') {
      const itemId = req.body?.item_id;
      if (itemId) for (const t of others.values()) if (t.db.get('SELECT 1 x FROM plaid_items WHERE item_id = ?', [itemId])) return t.app;
      return owner;
    }
    const uid = sessionUserId(req);
    if (uid && uid !== ownerId() && ownerDb.get('SELECT 1 x FROM users WHERE id = ?', [uid])) return open(uid).app;
    return owner;
  }

  const all = () => [owner, ...[...others.values()].map((t) => t.app)];
  return {
    handle: (req) => appFor(req).handle(req),
    async tick() { for (const a of all()) await a.tick(); },
    idle: () => Promise.all(all().map((a) => a.idle())),
    databases: () => [{ name: 'budget', db: ownerDb }, ...[...others.entries()].map(([id, t]) => ({ name: `user-${id}`, db: t.db }))],
    owner,
    appForUser: (id) => (id === ownerId() ? owner : open(id).app),
  };
}
