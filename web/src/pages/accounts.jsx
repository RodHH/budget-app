import { useState } from 'preact/hooks';
import { api, centsToInput, dateTime, money, parseMoney, timeAgo, ask } from '../lib.js';
import { connectBank } from '../plaid.js';
import { Field, Icon, MoneyInput, Seg, Sheet, Switch, useApp } from '../ui.jsx';

const ENV_LABEL = { sandbox: ['sandbox', 'Sandbox test data'], simulated: ['sandbox', 'Simulated (preview)'], production: ['live', 'Live'] };

export function Accounts() {
  const ctx = useApp();
  const { boot, refresh, notify } = ctx;
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(null);
  const plaid = boot.features.plaid;
  const manual = boot.accounts.filter((a) => a.source === 'manual');
  const detached = boot.accounts.filter((a) => a.source === 'plaid' && !a.plaid_item_id);

  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); } catch (e) { notify(e.message, true); } finally { setBusy(null); }
  };
  const syncItem = (it) => run(`sync-${it.id}`, async () => {
    const r = await api('POST', `/api/plaid/items/${it.id}/sync`);
    await refresh();
    window.dispatchEvent(new Event('bb:data'));
    notify(r.ok ? `Synced: ${r.added} new, ${r.updated} updated, ${r.removed} removed` : `Sync failed: ${r.error}`, !r.ok);
  });
  const addTestBank = () => run('sandbox', async () => {
    const r = await api('POST', '/api/plaid/sandbox-item');
    await refresh();
    window.dispatchEvent(new Event('bb:data'));
    notify(`${r.item.institution_name} connected with test data`);
  });
  const simulate = (it) => run(`sim-${it.id}`, async () => {
    const r = await api('POST', `/api/plaid/items/${it.id}/simulate`);
    await refresh();
    window.dispatchEvent(new Event('bb:data'));
    notify(`${r.posted} pending charge${r.posted === 1 ? '' : 's'} posted, 1 new pending`);
  });
  const [removing, setRemoving] = useState(null);
  const disconnect = (it, deleteData) => run(`rm-${it.id}`, async () => {
    await api('DELETE', `/api/plaid/items/${it.id}${deleteData ? '?delete_data=1' : ''}`);
    setRemoving(null);
    await refresh();
    window.dispatchEvent(new Event('bb:data'));
    notify(`${it.institution_name} disconnected`);
  });

  return (
    <div>
      <div class="page-head"><h1>Accounts</h1></div>

      <div class="section-title">Bank connections</div>
      {!plaid.configured && (
        <div class="card">
          <div class="row"><span class="pill">Awaiting setup</span></div>
          <p style="margin:10px 0 6px"><b>Bank sync isn’t configured on this server yet.</b></p>
          <p class="small muted" style="margin:0">Add your free Plaid keys on the server (never in this app or in chat), restart it, and a “Connect a bank” button appears here. The setup guide has the exact steps. Until then, everything works with manual transactions.</p>
          <a class="btn sm" style="margin-top:12px" href="#/more?section=setup">See setup status</a>
        </div>
      )}
      {plaid.configured && boot.items.length === 0 && (
        <div class="card">
          <p style="margin-top:0"><b>Connect your banks</b> to import transactions automatically. Access is read-only: the app can see balances and transactions, never move money.</p>
          {plaid.env !== 'production' && <p class="small muted">You’re in {plaid.env === 'simulated' ? 'the preview, with a simulated bank' : 'Plaid Sandbox'}. Everything you connect here is labeled test data.</p>}
        </div>
      )}
      {boot.items.map((it) => {
        const [cls, label] = ENV_LABEL[it.environment] || ['', it.environment];
        const broken = it.status === 'login_required';
        return (
          <div class="card">
            <div class="row between">
              <div class="grow">
                <div class="strong">{it.institution_name}</div>
                <div class="row wrap" style="gap:6px;margin-top:4px">
                  <span class={`pill ${cls}`}>{label}</span>
                  {broken && <span class="pill err">Needs sign-in</span>}
                  {it.status === 'error' && <span class="pill err">Last sync failed</span>}
                </div>
              </div>
              <button class="icon-btn" aria-label="Sync now" disabled={busy === `sync-${it.id}`} onClick={() => syncItem(it)}><Icon name="refresh" /></button>
            </div>
            <div class="small muted" style="margin-top:8px">
              Last successful sync: <b class="num">{it.last_success_at ? `${dateTime(it.last_success_at)} (${timeAgo(it.last_success_at)})` : 'not yet'}</b>
              {it.last_error && <div class="crit">Last attempt: {it.last_error}</div>}
            </div>
            <ul class="list" style="margin-top:8px">
              {it.accounts.map((a) => (
                <li class="row between" style="padding:10px 0">
                  <span class="ellipsis">{a.name} {a.mask ? <span class="muted">••{a.mask}</span> : null}</span>
                  <span class="amount">{a.type === 'credit' ? `${money(a.current_balance_cents)} owed` : money(a.current_balance_cents)}</span>
                </li>
              ))}
            </ul>
            <div class="row wrap" style="margin-top:8px;gap:8px">
              <button class="btn sm" disabled={!!busy} onClick={() => syncItem(it)}>{busy === `sync-${it.id}` ? 'Syncing…' : 'Sync now'}</button>
              {broken && <button class="btn sm primary" onClick={() => connectBank(ctx, it.id)}>Fix connection</button>}
              {it.environment === 'simulated' && <button class="btn sm" disabled={!!busy} onClick={() => simulate(it)}>Simulate new bank activity</button>}
              <button class="btn sm danger" disabled={!!busy} onClick={() => setRemoving(it)}>Disconnect</button>
            </div>
          </div>
        );
      })}
      {plaid.configured && (
        <div class="row wrap" style="margin-top:12px;gap:8px">
          {plaid.env !== 'simulated' && <button class="btn primary" onClick={() => connectBank(ctx)}><Icon name="plus" size={18} />Connect a bank</button>}
          {plaid.env !== 'production' && <button class="btn" disabled={busy === 'sandbox'} onClick={addTestBank}>{busy === 'sandbox' ? 'Connecting…' : plaid.env === 'simulated' ? 'Add simulated test bank' : 'Add Sandbox test bank'}</button>}
        </div>
      )}
      {plaid.configured && <p class="tiny muted" style="margin:10px 4px">The server checks each bank every {boot.settings.sync_interval_hours} hours{plaid.webhook ? ' and immediately when Plaid reports new activity' : ''}. Banks themselves often report purchases hours or a day late.</p>}

      <div class="section-title">Manual accounts</div>
      <div class="card flush">
        {manual.length === 0 && <div class="empty small">Optional. Use these for cash or banks you don’t connect.</div>}
        <ul class="list">
          {manual.map((a) => (
            <li>
              <button class="item" onClick={() => setEditing(a)}>
                <div class="icon-bubble">{a.type === 'credit' ? '💳' : a.type === 'cash' ? '💵' : '🏦'}</div>
                <div class="grow">
                  <div class="title ellipsis">{a.name} {a.is_sample ? <span class="pill sample">Sample</span> : null} {a.hidden ? <span class="pill">Hidden</span> : null}</div>
                  <div class="sub">{a.txn_count} transaction{a.txn_count === 1 ? '' : 's'}</div>
                </div>
                <span class="amount">{a.current_balance_cents === null ? '' : money(a.current_balance_cents)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <button class="btn block" style="margin-top:12px" onClick={() => setEditing({})}><Icon name="plus" size={18} />Add manual account</button>
      {detached.length > 0 && (
        <>
          <div class="section-title">Disconnected bank accounts</div>
          <div class="card flush"><ul class="list">{detached.map((a) => <li class="item"><div class="grow"><div class="title">{a.name}</div><div class="sub">History kept · {a.txn_count} transactions</div></div></li>)}</ul></div>
        </>
      )}
      {removing && (
        <Sheet title="Disconnect bank" onClose={() => setRemoving(null)}>
          <p>Stop syncing <b>{removing.institution_name}</b>? The app tells Plaid to revoke its access.</p>
          <div class="stack">
            <button class="btn block primary" disabled={!!busy} onClick={() => disconnect(removing, false)}>Disconnect, keep past transactions</button>
            <button class="btn block danger" disabled={!!busy} onClick={() => disconnect(removing, true)}>Disconnect and delete its data</button>
          </div>
          <p class="tiny muted">On Plaid’s free Trial plan, reconnecting later uses another of your 10 connections.</p>
        </Sheet>
      )}
      {editing && <AccountSheet acct={editing} onClose={() => setEditing(null)} onDone={async (m) => { setEditing(null); await refresh(); notify(m); window.dispatchEvent(new Event('bb:data')); }} />}
    </div>
  );
}

function AccountSheet({ acct, onClose, onDone }) {
  const { notify } = useApp();
  const isNew = !acct.id;
  const [f, setF] = useState({ name: acct.name || '', type: acct.type || 'depository', balance: centsToInput(acct.current_balance_cents), hidden: !!acct.hidden });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try {
      const bal = f.balance === '' ? null : parseMoney(f.balance);
      if (isNew) await api('POST', '/api/accounts', { name: f.name, type: f.type, current_balance_cents: bal });
      else await api('PATCH', `/api/accounts/${acct.id}`, { name: f.name, hidden: f.hidden, current_balance_cents: bal });
      onDone(isNew ? 'Account added' : 'Saved');
    } catch (e) { notify(e.message, true); }
  };
  const del = async () => {
    if (!(await ask(`Delete ${acct.name} and its ${acct.txn_count} transactions? This can’t be undone (export a backup first if unsure).`, { ok: 'Continue', danger: true }))) return;
    await api('DELETE', `/api/accounts/${acct.id}`);
    onDone('Account deleted');
  };
  return (
    <Sheet title={isNew ? 'New account' : 'Edit account'} onClose={onClose} actions={<button class="btn primary sm" onClick={save}>Save</button>}>
      <Field label="Name"><input class="input" value={f.name} onInput={(e) => set('name')(e.currentTarget.value)} placeholder="e.g. Cash wallet" /></Field>
      {isNew && <Field label="Type"><Seg label="Type" value={f.type} onChange={set('type')} options={[['depository', 'Bank'], ['credit', 'Credit card'], ['cash', 'Cash']]} /></Field>}
      <Field label="Balance (optional)"><MoneyInput value={f.balance} onInput={set('balance')} /></Field>
      {!isNew && <div class="card" style="padding:4px 16px"><Switch label="Hide from lists" checked={f.hidden} onChange={set('hidden')} /></div>}
      {!isNew && <button class="btn block danger" style="margin-top:16px" onClick={del}>Delete account</button>}
    </Sheet>
  );
}
