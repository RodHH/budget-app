import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from './lib.js';
import { AppCtx, Field, Icon, Toast } from './ui.jsx';
import { Dashboard } from './pages/dashboard.jsx';
import { Transactions } from './pages/transactions.jsx';
import { Budgets } from './pages/budgets.jsx';
import { Accounts } from './pages/accounts.jsx';
import { More } from './pages/more.jsx';
import { resumeOAuth } from './plaid.js';

const ICON = window.__BB_ICON__ || '/icons/icon-192.png';

const TABS = [
  ['dashboard', 'Home', 'home'],
  ['transactions', 'Activity', 'list'],
  ['budgets', 'Budgets', 'pie'],
  ['accounts', 'Accounts', 'bank'],
  ['more', 'More', 'more'],
];

function parseHash() {
  const h = (location.hash || '#/').slice(2);
  const [path, qs] = h.split('?');
  const [page, sub] = path.split('/');
  return { page: TABS.some((t) => t[0] === page) ? page : 'dashboard', sub: sub || null, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

export function navigate(page, query) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  location.hash = `#/${page}${qs}`;
}

function Auth({ state, onDone }) {
  const [form, setForm] = useState({ username: '', password: '', confirm: '', setup_code: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const setup = state.setup_required;
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });
  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    if (setup && form.password !== form.confirm) { setErr('Passwords don’t match.'); return; }
    setBusy(true);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await api('POST', setup ? '/api/auth/setup' : '/api/auth/login', { ...form, timezone: tz });
      onDone();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div class="auth">
      <form class="card" onSubmit={submit}>
        <img class="logo" src={ICON} alt="" />
        <h1>{setup ? 'Welcome' : 'Sign in'}</h1>
        <p class="muted" style="margin-top:0">{setup ? 'Create the single login that protects your budget. Only you will be able to open this app.' : 'Your budget is private. Sign in to continue.'}</p>
        {setup && state.setup_code_required && (
          <Field label="Setup code" hint="Printed in the server log the first time it starts. It proves you own this server.">
            <input class="input" autocomplete="one-time-code" value={form.setup_code} onInput={set('setup_code')} required />
          </Field>
        )}
        <Field label="Username"><input class="input" autocomplete="username" autocapitalize="none" value={form.username} onInput={set('username')} required /></Field>
        <Field label="Password" hint={setup ? 'At least 10 characters. A passphrase works well.' : null}>
          <input class="input" type="password" autocomplete={setup ? 'new-password' : 'current-password'} value={form.password} onInput={set('password')} required minLength={setup ? 10 : undefined} />
        </Field>
        {setup && <Field label="Confirm password"><input class="input" type="password" autocomplete="new-password" value={form.confirm} onInput={set('confirm')} required /></Field>}
        {err && <div class="banner alert" role="alert">{err}</div>}
        <button class="btn primary block" disabled={busy}>{setup ? 'Create login' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function App() {
  const [auth, setAuth] = useState(null);
  const [boot, setBoot] = useState(null);
  const [route, setRoute] = useState(parseHash());
  const [toast, setToast] = useState(null);

  const refresh = async () => {
    const b = await api('GET', '/api/bootstrap');
    setBoot(b);
    return b;
  };
  const checkAuth = async () => {
    try {
      const s = await api('GET', '/api/auth/state');
      setAuth(s);
      if (s.authenticated) await refresh();
    } catch (e) { setAuth({ error: e.message }); }
  };
  useEffect(() => {
    checkAuth();
    const onHash = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    const onOut = () => setAuth((a) => ({ ...(a || {}), authenticated: false }));
    window.addEventListener('hashchange', onHash);
    window.addEventListener('bb:signed-out', onOut);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('bb:signed-out', onOut); };
  }, []);
  useEffect(() => {
    if (boot && location.pathname === '/oauth-return') resumeOAuth(ctx);
  }, [!!boot]);

  const notify = (text, error = false) => {
    setToast({ text, error });
    clearTimeout(notify.t);
    notify.t = setTimeout(() => setToast(null), error ? 5000 : 2600);
  };
  const ctx = { boot, refresh, notify, route, navigate };

  if (!auth) return <div class="auth"><div class="muted">Loading…</div></div>;
  if (auth.error) return <div class="auth"><div class="card"><h1>Can’t connect</h1><p class="muted">{auth.error}</p><button class="btn primary" onClick={checkAuth}>Try again</button></div></div>;
  if (!auth.authenticated) return <Auth state={auth} onDone={checkAuth} />;
  if (!boot) return <div class="auth"><div class="muted">Loading…</div></div>;

  const Page = { dashboard: Dashboard, transactions: Transactions, budgets: Budgets, accounts: Accounts, more: More }[route.page];
  return (
    <AppCtx.Provider value={ctx}>
      <div class="shell">
        <nav class="tabbar" aria-label="Main">
          <div class="brand"><img src={ICON} alt="" />Budget</div>
          {TABS.map(([id, label, icon]) => (
            <a class="tab" href={`#/${id}`} aria-current={route.page === id ? 'page' : undefined}>
              <Icon name={icon} />{label}
              {id === 'more' && boot.unread_alerts > 0 && <span class="dot" aria-label={`${boot.unread_alerts} unread alerts`} />}
            </a>
          ))}
        </nav>
        <main class="main">
          {boot.features.demo && <div class="banner info small"><Icon name="info" size={18} /><div class="grow"><b>Interactive preview</b>Runs entirely in this browser with a simulated bank. Data stays in this browser only.</div></div>}
          <Page key={route.page} />
        </main>
      </div>
      <Toast toast={toast} />
    </AppCtx.Provider>
  );
}

if ('serviceWorker' in navigator && !window.__BB_DEMO__) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

export function mount(el) {
  render(<App />, el);
}
if (!window.__BB_DEMO__) mount(document.getElementById('app'));
