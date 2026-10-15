import { useEffect, useState } from 'preact/hooks';
import { api, dateTime, download, ask } from '../lib.js';
import { currentSubscription, deviceInfo, disablePush, enablePush, pushReadiness } from '../push.js';
import { Field, Icon, Loading, Switch, useApp, useAsync } from '../ui.jsx';
import { RulesSection } from './rules.jsx';

const SECTIONS = [
  ['alerts', 'Alerts & notifications', 'bell'],
  ['rules', 'Merchant rules', 'rules'],
  ['data', 'Backup, export & sample data', 'down'],
  ['prefs', 'Preferences', 'edit'],
  ['setup', 'Setup status', 'info'],
  ['install', 'Install on iPhone', 'home'],
  ['people', 'People', 'plus'],
  ['security', 'Password & sign out', 'ok'],
];

export function More() {
  const { route, navigate, boot } = useApp();
  const section = route.query.section;
  const current = SECTIONS.find((s) => s[0] === section);
  if (!current) {
    return (
      <div>
        <div class="page-head"><h1>More</h1></div>
        <div class="card flush">
          <ul class="list">
            {SECTIONS.filter(([id]) => id !== 'people' || (boot.user.is_owner && boot.user.people_enabled)).map(([id, label, icon]) => (
              <li>
                <button class="item" onClick={() => navigate('more', { section: id })}>
                  <div class="icon-bubble"><Icon name={icon} size={20} /></div>
                  <div class="grow title">{label}</div>
                  {id === 'alerts' && boot.unread_alerts > 0 && <span class="pill err">{boot.unread_alerts} new</span>}
                  <Icon name="right" size={18} />
                </button>
              </li>
            ))}
          </ul>
        </div>
        <p class="tiny muted" style="margin:16px 4px">Signed in as {boot.user.username}. Budget math runs entirely on your own server; no AI service is used.</p>
      </div>
    );
  }
  const Body = { alerts: AlertsSection, rules: RulesSection, data: DataSection, prefs: PrefsSection, setup: SetupSection, install: InstallSection, security: SecuritySection, people: PeopleSection }[section];
  return (
    <div>
      <div class="page-head" style="justify-content:flex-start">
        <a class="icon-btn" href="#/more" aria-label="Back"><Icon name="left" /></a>
        <h1 style="font-size:22px">{current[1]}</h1>
      </div>
      <Body />
    </div>
  );
}

// ---------------------------------------------------------------- alerts & push
function AlertsSection() {
  const { boot, refresh, notify } = useApp();
  const [thresholds, setThresholds] = useState(boot.settings.alert_thresholds);
  const [newT, setNewT] = useState('');
  const [sub, setSub] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const push = useAsync(() => api('GET', '/api/push/status'), []);
  const history = useAsync(() => api('GET', '/api/alerts'), []);
  const info = deviceInfo();
  const ready = pushReadiness(info, boot.features.push.configured && !boot.features.demo);
  useEffect(() => { currentSubscription().then((s) => setSub(s)).catch(() => setSub(null)); }, []);
  useEffect(() => { if (boot.unread_alerts) api('POST', '/api/alerts/read-all').then(refresh); }, []);

  const saveThresholds = async (t) => {
    try {
      const r = await api('PUT', '/api/settings', { alert_thresholds: t });
      setThresholds(r.settings.alert_thresholds);
      await refresh();
      notify('Alert thresholds saved');
    } catch (e) { notify(e.message, true); }
  };
  const turnOn = async () => {
    setBusy(true);
    try { setSub(await enablePush(boot.features.push.public_key)); push.reload(); notify('Notifications are on for this device'); } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  const turnOff = async () => { await disablePush(); setSub(null); push.reload(); notify('Notifications off for this device'); };
  const test = async () => {
    try {
      const r = await api('POST', '/api/push/test');
      const ok = r.results.filter((x) => x.ok).length;
      notify(ok ? `Test sent to ${ok} device${ok === 1 ? '' : 's'}` : `Couldn’t deliver: ${r.results[0]?.error || 'unknown error'}`, !ok);
      push.reload();
    } catch (e) { notify(e.message, true); }
  };
  const removeDevice = async (id) => { await api('POST', '/api/push/unsubscribe', { id }); push.reload(); };

  return (
    <div>
      <div class="card">
        <div class="strong">Thresholds</div>
        <p class="small muted" style="margin:4px 0 12px">You’ll get one alert per threshold, per budget, per period. If a refund drops you back under, you won’t be alerted again for that threshold until the budget resets.</p>
        <div class="row wrap" style="gap:8px">
          {thresholds.map((t) => (
            <span class="chip" aria-pressed="true" style="display:inline-flex;align-items:center;gap:6px">
              {t}%<button class="icon-btn" style="width:28px;height:28px;color:inherit" aria-label={`Remove ${t}%`} onClick={() => saveThresholds(thresholds.filter((x) => x !== t))}><Icon name="x" size={14} /></button>
            </span>
          ))}
          {thresholds.length < 5 && (
            <form class="row" style="gap:6px" onSubmit={(e) => { e.preventDefault(); const n = parseInt(newT, 10); if (n > 0) { saveThresholds([...thresholds, n]); setNewT(''); } }}>
              <input class="input" style="width:90px;min-height:40px" inputMode="numeric" placeholder="e.g. 50" value={newT} onInput={(e) => setNewT(e.currentTarget.value)} aria-label="New threshold percent" />
              <button class="btn sm">Add</button>
            </form>
          )}
        </div>
      </div>

      <div class="section-title">Notifications on this device</div>
      <div class="card">
        {ready.state === 'ready' ? (
          <>
            <div class="row between">
              <div>
                <div class="strong">{sub ? 'On' : 'Off'}</div>
                <div class="small muted">{sub ? 'Alerts arrive here even when the app is closed.' : 'Turn on to get budget alerts as push notifications.'}</div>
              </div>
              <span class={`pill ${sub ? 'live' : ''}`}>{sub ? 'Working' : 'Not enabled'}</span>
            </div>
            <div class="row wrap" style="gap:8px;margin-top:12px">
              {!sub && <button class="btn primary" disabled={busy} onClick={turnOn}><Icon name="bell" size={18} />Turn on notifications</button>}
              {sub && <button class="btn" onClick={test}>Send test notification</button>}
              {sub && <button class="btn danger" onClick={turnOff}>Turn off</button>}
            </div>
          </>
        ) : (
          <div class="row" style="align-items:flex-start">
            <span class="pill">{ready.state === 'server' ? 'Awaiting setup' : ready.state === 'install' ? 'Install first' : 'Unavailable'}</span>
            <div class="small grow">{boot.features.demo ? 'Push notifications can’t run inside this preview. On your own server they work as described in the setup guide.' : ready.text}{ready.state === 'install' && <> <a href="#/more?section=install">How to install</a></>}</div>
          </div>
        )}
        <p class="tiny muted" style="margin:12px 0 0">Alerts appear in the app either way. Push only tells you after a purchase shows up from your bank; it can’t stop a purchase, and bank data can lag hours or more.</p>
      </div>
      {push.data?.devices?.length > 0 && (
        <div class="card flush" style="margin-top:12px">
          <ul class="list">
            {push.data.devices.map((d) => (
              <li class="row" style="padding:10px 16px">
                <div class="grow"><div>{d.label}</div><div class="tiny muted">Added {dateTime(d.created_at)}{d.last_success_at ? ` · last delivered ${dateTime(d.last_success_at)}` : ''}{d.last_error ? ` · error: ${d.last_error}` : ''}</div></div>
                <button class="btn sm" onClick={() => removeDevice(d.id)}>Remove</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div class="section-title">Recent alerts</div>
      <div class="card flush">
        {!history.data ? <Loading /> : history.data.alerts.length === 0 ? <div class="empty small">No alerts yet.</div> : (
          <ul class="list">
            {history.data.alerts.map((a) => (
              <li class="item" style="cursor:default">
                <div class="icon-bubble">{a.icon || '🔔'}</div>
                <div class="grow">
                  <div class="title">{a.title}</div>
                  <div class="sub">{a.body}</div>
                  <div class="tiny muted">{dateTime(a.created_at)} · {pushLabel(a.push_result)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function pushLabel(r) {
  if (!r) return 'sending…';
  if (r === 'push_not_configured') return 'in-app only (push not set up)';
  if (r === 'no_devices') return 'in-app only (no devices turned on)';
  if (r.includes('sent')) return 'pushed to your devices';
  return `push ${r}`;
}

// ---------------------------------------------------------------- data
function DataSection() {
  const { boot, refresh, notify } = useApp();
  const [busy, setBusy] = useState(false);
  const exportJson = async () => {
    const res = await fetch('/api/export/json', { credentials: 'same-origin' });
    download(`budget-backup-${boot.today}.json`, await res.text(), 'application/json');
  };
  const exportCsv = async () => {
    const res = await fetch('/api/export/csv', { credentials: 'same-origin' });
    download(`transactions-${boot.today}.csv`, await res.text(), 'text/csv');
  };
  const importFile = async (e) => {
    const file = e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch { notify('That file isn’t a valid backup.', true); return; }
    if (!(await ask(`Restore this backup from ${data.exported_at ? dateTime(data.exported_at) : 'an unknown date'}?\n\nIt replaces your current categories, budgets, rules, accounts and transactions. Bank connections stay connected.`, { ok: 'Continue', danger: true }))) return;
    setBusy(true);
    try {
      const r = await api('POST', '/api/import/json', { data });
      await refresh();
      window.dispatchEvent(new Event('bb:data'));
      notify(`Restored ${r.counts.transactions} transactions`);
    } catch (x) { notify(x.message, true); } finally { setBusy(false); }
  };
  const sample = async (load) => {
    setBusy(true);
    try {
      await api('POST', load ? '/api/sample/load' : '/api/sample/remove');
      await refresh();
      window.dispatchEvent(new Event('bb:data'));
      notify(load ? 'Sample data added. Look for the “Sample” labels.' : 'Sample data removed');
    } finally { setBusy(false); }
  };
  return (
    <div>
      <div class="card stack">
        <div><div class="strong">Backup</div><div class="small muted">A complete copy of your categories, budgets, rules, accounts, transactions and settings. Bank login tokens are never included.</div></div>
        <button class="btn block" onClick={exportJson}>Download backup (.json)</button>
        <label class="btn block" style="position:relative">
          Restore from backup…
          <input type="file" accept="application/json,.json" onChange={importFile} disabled={busy} style="position:absolute;inset:0;opacity:0;cursor:pointer" />
        </label>
      </div>
      <div class="card stack">
        <div><div class="strong">Export transactions</div><div class="small muted">A CSV you can open anywhere.</div></div>
        <button class="btn block" onClick={exportCsv}>Download transactions (.csv)</button>
      </div>
      <div class="card stack">
        <div><div class="strong">Sample data</div><div class="small muted">Two months of made-up transactions, a few budgets and a Starbucks rule so you can explore. Everything is labeled “Sample” and removes in one tap without touching your own data.</div></div>
        {boot.has_sample
          ? <button class="btn block danger" disabled={busy} onClick={() => sample(false)}>Remove sample data</button>
          : <button class="btn block" disabled={busy} onClick={() => sample(true)}>Add sample data</button>}
      </div>
      {boot.features.demo && <p class="tiny muted" style="margin:12px 4px">File downloads are blocked inside this preview; they work in the installed app.</p>}
      {!boot.features.demo && <p class="tiny muted" style="margin:12px 4px">The server also keeps a daily copy of the database for the last 14 days in its data folder.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- preferences
function PrefsSection() {
  const { boot, refresh, notify } = useApp();
  const zones = (() => { try { return Intl.supportedValuesOf('timeZone').filter((z) => z.startsWith('America/') || z.startsWith('Pacific/Honolulu') || z === 'UTC'); } catch { return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']; } })();
  const save = async (patch) => {
    try { await api('PUT', '/api/settings', patch); await refresh(); window.dispatchEvent(new Event('bb:data')); notify('Saved'); } catch (e) { notify(e.message, true); }
  };
  const s = boot.settings;
  return (
    <div class="card">
      <Switch label="Count pending transactions" hint="On: budgets react as soon as a purchase appears. Off: only posted transactions count." checked={s.include_pending} onChange={(v) => save({ include_pending: v })} />
      <Field label="Time zone" hint="Decides when “today” starts and when budgets reset.">
        <select class="input" value={s.timezone} onChange={(e) => save({ timezone: e.currentTarget.value })}>
          {[...new Set([s.timezone, ...zones])].map((z) => <option value={z}>{z.replace(/_/g, ' ')}</option>)}
        </select>
      </Field>
      <Field label="Check banks every" hint="The server also syncs right away when Plaid reports new activity (if webhooks are set up).">
        <select class="input" value={s.sync_interval_hours} onChange={(e) => save({ sync_interval_hours: Number(e.currentTarget.value) })}>
          {[1, 2, 4, 6, 12, 24].map((h) => <option value={h}>{h} hour{h === 1 ? '' : 's'}</option>)}
        </select>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------- setup status
function StatusLine({ ok, title, children }) {
  return (
    <div class="status-line">
      <span class={ok ? 'good' : 'warn-text'}><Icon name={ok ? 'ok' : 'warn'} /></span>
      <div class="grow"><div class="strong">{title}</div><div class="small muted">{children}</div></div>
    </div>
  );
}

function SetupSection() {
  const { boot } = useApp();
  const f = boot.features;
  const info = deviceInfo();
  return (
    <div>
      <div class="card">
        <StatusLine ok title="Budgets, transactions, rules, alerts in the app">Working. Saved on the server{f.demo ? ' (in this preview: saved in this browser)' : ''}.</StatusLine>
        <StatusLine ok={f.plaid.configured} title={`Bank sync (Plaid${f.plaid.env ? ` ${f.plaid.env}` : ''})`}>
          {f.plaid.configured ? (f.plaid.env === 'production' ? 'Connected to real banks (read-only).' : f.plaid.env === 'simulated' ? 'Simulated bank for this preview.' : 'Sandbox: test banks and fake data only.') : 'Awaiting setup: add PLAID_CLIENT_ID and PLAID_SECRET on the server.'}
        </StatusLine>
        <StatusLine ok={f.plaid.webhook} title="Instant bank updates (webhooks)">{f.plaid.webhook ? 'Plaid can notify the server about new transactions.' : 'Needs a public HTTPS address (PUBLIC_URL). Until then the server checks on a schedule.'}</StatusLine>
        <StatusLine ok={f.plaid.redirect_uri} title="Bank OAuth redirect (optional)">{f.plaid.redirect_uri ? 'Set.' : 'Optional; recommended for banks like Chase on iPhone. Set PLAID_REDIRECT_URI to your-address/oauth-return.'}</StatusLine>
        <StatusLine ok={f.push.configured && f.https && f.push.subject_set} title="Push notifications">
          {f.demo ? 'Not available in the preview.' : !f.https ? 'Needs the app served over HTTPS (set PUBLIC_URL).' : !f.push.subject_set ? 'Set VAPID_SUBJECT to mailto:your-email so Apple accepts the notifications.' : 'Ready. Turn them on per device under Alerts & notifications.'}
        </StatusLine>
        <StatusLine ok={info.standalone} title="Installed on this device">{info.standalone ? 'Running from the Home Screen.' : 'Running in the browser. See “Install on iPhone”.'}</StatusLine>
      </div>
      <p class="tiny muted" style="margin:12px 4px">Keys and secrets live only in the server’s environment settings. This app never asks you to type them in, and they never reach your phone.</p>
    </div>
  );
}

function InstallSection() {
  return (
    <div class="card">
      <ol class="steps">
        <li>Open the app’s address in <b>Safari</b> on your iPhone (must be the HTTPS address).</li>
        <li>Tap the <b>Share</b> button, then <b>Add to Home Screen</b>. Keep “Open as Web App” on, then tap <b>Add</b>.</li>
        <li>Open <b>Budget</b> from your Home Screen and sign in.</li>
        <li>Go to <b>More → Alerts & notifications</b> and tap <b>Turn on notifications</b>, then <b>Allow</b>.</li>
        <li>Tap <b>Send test notification</b>, lock your phone and wait a moment to confirm it arrives.</li>
      </ol>
      <p class="small muted">Needs iOS 16.4 or later. Notifications only work from the Home Screen app, not a Safari tab. To change them later: Settings → Notifications → Budget. Focus modes can silence them.</p>
    </div>
  );
}

function SecuritySection() {
  const { notify, boot } = useApp();
  const [f, setF] = useState({ current: '', next: '' });
  const change = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/auth/password', f); notify('Password changed. Please sign in again.'); setTimeout(() => location.reload(), 800); } catch (x) { notify(x.message, true); }
  };
  const signOut = async () => { await api('POST', '/api/auth/logout', {}); location.reload(); };
  if (boot.features.demo) return <div class="card small muted">Sign-in is turned off in the preview. On your server, the app requires your username and password, sessions last 30 days, and failed sign-ins are rate limited.</div>;
  return (
    <div>
      <form class="card" onSubmit={change}>
        <Field label="Current password"><input class="input" type="password" autocomplete="current-password" value={f.current} onInput={(e) => setF({ ...f, current: e.currentTarget.value })} /></Field>
        <Field label="New password" hint="At least 10 characters. Changing it signs out every device."><input class="input" type="password" autocomplete="new-password" value={f.next} onInput={(e) => setF({ ...f, next: e.currentTarget.value })} /></Field>
        <button class="btn primary block">Change password</button>
      </form>
      <button class="btn block" style="margin-top:12px" onClick={signOut}>Sign out</button>
    </div>
  );
}

// ---------------------------------------------------------------- people
function PeopleSection() {
  const { notify, boot } = useApp();
  const [people, setPeople] = useState(null);
  const [f, setF] = useState({ username: '', password: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('GET', '/api/people').then((r) => setPeople(r.people)).catch((x) => notify(x.message, true)); }, []);
  if (!boot.user.is_owner) return <div class="card small muted">Only the person who set up the app can add or remove people.</div>;
  if (!people) return <Loading />;
  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api('POST', '/api/people', f);
      setPeople(r.people);
      notify(`Added ${f.username}. Give them the username and password; they can change the password under Password & sign out.`);
      setF({ username: '', password: '' });
    } catch (x) { notify(x.message, true); }
    setBusy(false);
  };
  const remove = async (p) => {
    if (!(await ask(`Remove ${p.username}? They’re signed out, their bank connections are disconnected, and their budget is moved into the server’s backups folder.`, { ok: 'Remove', danger: true }))) return;
    try { setPeople((await api('DELETE', `/api/people/${p.id}`)).people); notify(`Removed ${p.username}.`); } catch (x) { notify(x.message, true); }
  };
  return (
    <div>
      <p class="small muted" style="margin:0 4px 12px">Everyone here has their own login and a completely separate budget: their own banks, categories, rules, alerts and notifications. Nobody can see anyone else’s.</p>
      <div class="card flush">
        <ul class="list">
          {people.map((p) => (
            <li class="item">
              <div class="grow"><div class="title">{p.username}</div><div class="tiny muted">{p.is_owner ? 'You (owner)' : `Added ${dateTime(p.created_at)}`}</div></div>
              {!p.is_owner && <button class="btn sm danger" onClick={() => remove(p)}>Remove</button>}
            </li>
          ))}
        </ul>
      </div>
      <form class="card" style="margin-top:12px" onSubmit={add}>
        <h2 style="margin-top:0;font-size:17px">Add a person</h2>
        <Field label="Username"><input class="input" autocapitalize="none" autocomplete="off" value={f.username} onInput={(e) => setF({ ...f, username: e.currentTarget.value })} /></Field>
        <Field label="Starting password" hint="At least 10 characters. Tell it to them in person; they can change it after signing in."><input class="input" type="text" autocomplete="new-password" value={f.password} onInput={(e) => setF({ ...f, password: e.currentTarget.value })} /></Field>
        <button class="btn primary block" disabled={busy}>Add person</button>
      </form>
      <p class="tiny muted" style="margin:12px 4px">Bank connections from everyone count toward your Plaid plan’s limit.</p>
    </div>
  );
}
