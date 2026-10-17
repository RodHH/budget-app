import { useState } from 'preact/hooks';
import { api, ask, centsToInput, dayLabel, money, parseMoney } from '../lib.js';
import { BucketSelect, Field, Icon, Loading, MoneyInput, Sheet, useApp, useAsync } from '../ui.jsx';

const COLORS = ['#2f6b5e', '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6', '#8a5a3c'];

const monthYear = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

/** The Savings tab on the Budgets page: buckets inside each savings account. */
export function SavingsTab() {
  const { boot, refresh, notify } = useApp();
  const [editing, setEditing] = useState(null);
  const [moving, setMoving] = useState(null);
  const accounts = boot.savings.accounts.filter((a) => !a.hidden || a.buckets.length);
  const done = async (msg) => { setEditing(null); setMoving(null); await refresh(); if (msg) notify(msg); window.dispatchEvent(new Event('bb:data')); };

  if (!accounts.length) {
    return (
      <div class="card empty" style="margin-top:12px">
        <div class="big">🏦</div>
        Buckets live inside a savings account. Connect your bank, or add a savings account by hand, on the <a href="#/accounts">Accounts</a> tab.
      </div>
    );
  }
  return (
    <div>
      <p class="small muted" style="margin:12px 4px 0">Split a savings account into buckets. Tag deposits and withdrawals to a bucket, or mark a purchase as paid from one.</p>
      {accounts.map((a) => (
        <div class="card flush" style="margin-top:12px">
          <div class="row between" style="padding:14px 16px 6px">
            <div class="grow" style="min-width:0">
              <div class="title ellipsis" style="font-weight:600">{a.name}{a.mask ? ` ••${a.mask}` : ''}</div>
              <div class="small muted">{a.institution || 'Savings account'}</div>
            </div>
            <div class="amount num" style="font-size:18px">{a.balance_cents == null ? '—' : money(a.balance_cents)}</div>
          </div>
          <ul class="list">
            {a.buckets.map((b) => <li><BucketRow b={b} onClick={() => setEditing(b)} /></li>)}
            {a.unassigned_cents != null && (
              <li>
                <button class="item" onClick={() => a.buckets.length && setMoving({ account: a, from: null })}>
                  <div class="icon-bubble">🪙</div>
                  <div class="grow">
                    <div class="title">Not assigned</div>
                    <div class="sub">{a.unassigned_cents < 0 ? 'Your buckets hold more than the account. Take money out of a bucket.' : a.buckets.length ? 'Tap to put it in a bucket.' : 'Add a bucket to start.'}</div>
                  </div>
                  <div class={`amount ${a.unassigned_cents < 0 ? 'crit' : ''}`}>{money(a.unassigned_cents)}</div>
                </button>
              </li>
            )}
          </ul>
          <div class="row wrap" style="padding:8px 16px 16px;gap:8px">
            <button class="btn sm" onClick={() => setEditing({ account_id: a.id })}><Icon name="plus" size={16} />New bucket</button>
            {a.buckets.length > 0 && <button class="btn sm" onClick={() => setMoving({ account: a, from: a.buckets[0].id })}>Move money</button>}
          </div>
        </div>
      ))}
      {editing && <BucketSheet bucket={editing} accounts={accounts} onClose={() => setEditing(null)} onDone={done} onMove={(b) => { setEditing(null); setMoving({ account: accounts.find((x) => x.id === b.account_id), from: b.id }); }} />}
      {moving && <MoveSheet account={moving.account} from={moving.from} onClose={() => setMoving(null)} onDone={done} />}
    </div>
  );
}

function BucketRow({ b, onClick }) {
  const goal = b.goal_cents ? Math.min(1, b.goal_pct) : null;
  const target = b.monthly_target_cents ? Math.min(1, Math.max(0, b.month_cents / b.monthly_target_cents)) : null;
  const pct = goal ?? target;
  let sub;
  if (b.goal_cents) {
    sub = `Goal ${money(b.goal_cents, { whole: true })}${b.goal_date ? ` by ${monthYear(b.goal_date)}` : ''}`;
    if (b.needed_per_month_cents) sub += ` · ${money(b.needed_per_month_cents, { whole: true })}/mo to get there`;
  } else if (b.monthly_target_cents) {
    sub = `${money(Math.max(0, b.month_cents))} of ${money(b.monthly_target_cents, { whole: true })} saved this month`;
  } else {
    sub = b.month_cents ? `${money(b.month_cents, { sign: true })} this month` : 'No change this month';
  }
  return (
    <button class="item" onClick={onClick} style="flex-direction:column;align-items:stretch;gap:0">
      <div class="row" style="align-items:flex-start">
        <div class="icon-bubble" style={{ background: `${b.color || '#2f6b5e'}22` }}>{b.icon}</div>
        <div class="grow" style="min-width:0">
          <div class="title ellipsis">{b.name}</div>
          <div class="sub">{sub}</div>
        </div>
        <div class="budget-right">
          <span class={`amount ${b.balance_cents < 0 ? 'crit' : ''}`}>{money(b.balance_cents)}</span>
          {b.monthly_target_cents ? (
            b.target_met
              ? <span class="status-tag good"><Icon name="ok" />Saved this month</span>
              : <span class="status-tag muted">{money(b.monthly_target_cents - b.month_cents)} to go</span>
          ) : null}
        </div>
      </div>
      {pct != null && (
        <div class="progress save" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(pct * 100)} aria-label={`${b.name} ${goal != null ? 'goal' : 'monthly target'} progress`}>
          <span style={{ width: `${Math.round(pct * 100)}%` }} />
        </div>
      )}
    </button>
  );
}

function BucketSheet({ bucket, accounts, onClose, onDone, onMove }) {
  const { boot, notify } = useApp();
  const isNew = !bucket.id;
  const [f, setF] = useState({
    account_id: bucket.account_id, name: bucket.name || '', icon: bucket.icon || '💰', color: bucket.color || COLORS[0],
    target: centsToInput(bucket.monthly_target_cents), goal: centsToInput(bucket.goal_cents), goal_date: bucket.goal_date || '', start: '',
  });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const activity = useAsync(() => (isNew ? Promise.resolve(null) : api('GET', `/api/buckets/${bucket.id}/activity`)), [bucket.id]);
  const account = accounts.find((a) => a.id === Number(f.account_id));
  const save = async () => {
    try {
      const body = {
        name: f.name, icon: f.icon, color: f.color,
        monthly_target_cents: parseMoney(f.target) || null, goal_cents: parseMoney(f.goal) || null, goal_date: f.goal_date || null,
      };
      if (isNew) await api('POST', '/api/buckets', { ...body, account_id: Number(f.account_id), starting_cents: parseMoney(f.start) || 0 });
      else await api('PATCH', `/api/buckets/${bucket.id}`, body);
      onDone(isNew ? 'Bucket added' : 'Saved');
    } catch (e) { notify(e.message, true); }
  };
  const del = async () => {
    if (bucket.balance_cents !== 0) { notify('Move this bucket’s money somewhere else first.', true); return; }
    if (!(await ask(`Delete ${bucket.name}? Transactions tagged to it go back to not assigned.`, { ok: 'Delete', danger: true }))) return;
    try { await api('DELETE', `/api/buckets/${bucket.id}`); onDone('Bucket deleted'); } catch (e) { notify(e.message, true); }
  };
  return (
    <Sheet title={isNew ? 'New savings bucket' : bucket.name} onClose={onClose} actions={<button class="btn primary sm" onClick={save}>Save</button>}>
      {!isNew && (
        <div class="card" style="margin-bottom:14px">
          <div class="small muted">In this bucket</div>
          <div class="hero-value num" style="font-size:30px">{money(bucket.balance_cents)}</div>
          <button class="btn sm" style="margin-top:10px" onClick={() => onMove(bucket)}>Move money</button>
        </div>
      )}
      <div class="row" style="align-items:flex-start">
        <Field label="Icon"><input class="input" style="width:72px;text-align:center;font-size:24px" value={f.icon} maxLength={4} onInput={(e) => set('icon')(e.currentTarget.value)} aria-label="Emoji icon" /></Field>
        <div class="grow"><Field label="Name"><input class="input" value={f.name} onInput={(e) => set('name')(e.currentTarget.value)} placeholder="e.g. House Savings" /></Field></div>
      </div>
      <Field label="Color">
        <div class="swatches">{COLORS.map((c) => <button type="button" class="swatch" style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={String(f.color === c)} onClick={() => set('color')(c)} />)}</div>
      </Field>
      {isNew && accounts.length > 1 && (
        <Field label="Savings account">
          <select class="input" value={f.account_id} onChange={(e) => set('account_id')(Number(e.currentTarget.value))}>
            {accounts.map((a) => <option value={a.id}>{a.name}{a.mask ? ` ••${a.mask}` : ''}</option>)}
          </select>
        </Field>
      )}
      <Field label="Monthly target (optional)" hint="How much you want to put in each month."><MoneyInput value={f.target} onInput={set('target')} placeholder="200" /></Field>
      <div class="row">
        <Field label="Goal (optional)"><MoneyInput value={f.goal} onInput={set('goal')} placeholder="20,000" /></Field>
        <Field label="By"><input class="input" type="date" value={f.goal_date} onInput={(e) => set('goal_date')(e.currentTarget.value)} /></Field>
      </div>
      {isNew && (
        <Field label="Already saved for this" hint={account?.unassigned_cents != null ? `Comes out of the ${money(account.unassigned_cents)} not assigned yet in ${account.name}.` : null}>
          <MoneyInput value={f.start} onInput={set('start')} placeholder="0.00" />
        </Field>
      )}
      {!isNew && (
        <>
          <div class="section-title" style="margin-top:20px">Activity</div>
          {!activity.data ? <Loading /> : activity.data.activity.length === 0 ? <p class="small muted">Nothing yet. Tag a deposit to this bucket from Activity.</p> : (
            <div class="card flush">
              <ul class="list">
                {activity.data.activity.map((m) => (
                  <li class="item" style="cursor:default">
                    <div class="grow" style="min-width:0">
                      <div class="title ellipsis">{m.merchant || m.note || 'Adjustment'}</div>
                      <div class="sub ellipsis">{m.date ? dayLabel(m.date, boot.today) : ''}{m.kind === 'paid_from' ? ` · paid from savings${m.account_name ? ` with ${m.account_name}` : ''}` : ''}</div>
                    </div>
                    <div class={`amount ${m.amount_cents > 0 ? 'in' : ''}`}>{money(m.amount_cents, { sign: true })}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button class="btn block danger" style="margin-top:16px" onClick={del}>Delete bucket</button>
        </>
      )}
    </Sheet>
  );
}

function MoveSheet({ account, from, onClose, onDone }) {
  const { boot, notify } = useApp();
  const [f, setF] = useState({ from: from ?? null, to: null, amount: '' });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const name = (id) => (id == null ? 'Not assigned' : account.buckets.find((b) => b.id === id)?.name);
  const available = f.from == null ? account.unassigned_cents : account.buckets.find((b) => b.id === f.from)?.balance_cents;
  const save = async () => {
    const amount_cents = parseMoney(f.amount);
    if (!amount_cents || amount_cents <= 0) { notify('Enter an amount above $0', true); return; }
    if (f.from === f.to) { notify('Pick two different places', true); return; }
    try {
      await api('POST', '/api/buckets/move', { from_bucket_id: f.from, to_bucket_id: f.to, amount_cents });
      onDone(`Moved ${money(amount_cents)} to ${name(f.to)}`);
    } catch (e) { notify(e.message, true); }
  };
  return (
    <Sheet title="Move money" onClose={onClose} actions={<button class="btn primary sm" onClick={save}>Move</button>}>
      <p class="small muted" style="margin-top:0">This only changes which bucket the money belongs to. Nothing moves at your bank.</p>
      <Field label="From" hint={available != null ? `${money(available)} available` : null}>
        <BucketSelect savings={boot.savings} accountId={account.id} value={f.from} onChange={set('from')} />
      </Field>
      <Field label="To"><BucketSelect savings={boot.savings} accountId={account.id} value={f.to} onChange={set('to')} /></Field>
      <Field label="Amount"><MoneyInput value={f.amount} onInput={set('amount')} /></Field>
    </Sheet>
  );
}
