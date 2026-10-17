import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, centsToInput, dayLabel, money, parseMoney, ask } from '../lib.js';
import { BucketSelect, CategorySelect, Field, Icon, MoneyInput, Seg, Sheet, Switch, TxnPills, TxnRow, useApp } from '../ui.jsx';
import { RuleSheet } from './rules.jsx';
import { SampleBanner } from './dashboard.jsx';

const STATUS = [
  ['', 'All'], ['spending', 'Spending'], ['income', 'Income'], ['refunds', 'Refunds'], ['transfers', 'Transfers'],
  ['pending', 'Pending'], ['uncategorized', 'Uncategorized'], ['excluded', 'Excluded'], ['manual', 'Manual'], ['bank', 'From bank'],
];

export function Transactions() {
  const { boot, route, notify } = useApp();
  const q0 = route.query;
  const [filters, setFilters] = useState({ q: q0.q || '', status: q0.status || '', category: q0.category || '', account: q0.account || '', from: q0.from || '', to: q0.to || '' });
  const [qDebounced, setQ] = useState(filters.q);
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(null);
  const [ruleFor, setRuleFor] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [bulkCat, setBulkCat] = useState(false);
  const [showFilters, setShowFilters] = useState(!!(q0.category || q0.account || q0.from));

  useEffect(() => { const t = setTimeout(() => setQ(filters.q), 250); return () => clearTimeout(t); }, [filters.q]);
  const params = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, q: qDebounced })) if (v) p.set(k, v);
    return p;
  }, [qDebounced, filters.status, filters.category, filters.account, filters.from, filters.to]);

  const load = async (append = false, off = 0) => {
    const p = new URLSearchParams(params);
    p.set('limit', '100'); p.set('offset', String(off));
    const r = await api('GET', `/api/transactions?${p}`);
    setData((d) => (append && d ? { ...r, transactions: [...d.transactions, ...r.transactions] } : r));
    setOffset(off);
  };
  useEffect(() => { load(); }, [params]);
  useEffect(() => {
    const h = () => load();
    window.addEventListener('bb:data', h);
    return () => window.removeEventListener('bb:data', h);
  }, [params]);
  useEffect(() => {
    if (q0.new) setEditing({});
    if (q0.open) api('GET', `/api/transactions/${Number(q0.open)}`).then((r) => setEditing(r.transaction)).catch(() => {});
  }, []);

  const groups = useMemo(() => {
    const g = [];
    for (const t of data?.transactions || []) {
      const last = g[g.length - 1];
      if (last && last.date === t.date) last.items.push(t); else g.push({ date: t.date, items: [t] });
    }
    return g;
  }, [data]);

  const set = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }));
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const bulk = async (body) => {
    const r = await api('POST', '/api/transactions/bulk', { ids: [...selected], ...body });
    notify(`Updated ${r.updated} transaction${r.updated === 1 ? '' : 's'}`);
    setSelected(new Set()); setSelecting(false); setBulkCat(false);
    load();
  };
  const saved = () => { setEditing(null); load(); window.dispatchEvent(new Event('bb:data')); };
  const activeFilters = ['category', 'account', 'from', 'to'].filter((k) => filters[k]).length;

  return (
    <div>
      <div class="page-head">
        <h1>Activity</h1>
        <div class="row" style="gap:4px">
          <a class="btn sm" href="#/more?section=rules"><Icon name="rules" size={18} />Rules</a>
          <button class="btn sm" onClick={() => { setSelecting(!selecting); setSelected(new Set()); }}>{selecting ? 'Done' : 'Select'}</button>
        </div>
      </div>
      <SampleBanner />
      <div class="search">
        <Icon name="search" />
        <input class="input" type="search" placeholder="Search merchant, note, category or amount" value={filters.q} onInput={(e) => set('q')(e.currentTarget.value)} aria-label="Search transactions" />
      </div>
      <div class="chips" style="margin-top:10px" role="group" aria-label="Filter by type">
        <button class="chip" aria-pressed={String(showFilters || activeFilters > 0)} onClick={() => setShowFilters(!showFilters)}>Filters{activeFilters ? ` (${activeFilters})` : ''}</button>
        {STATUS.map(([v, l]) => <button class="chip" aria-pressed={String(filters.status === v)} onClick={() => set('status')(v)}>{l}</button>)}
      </div>
      {showFilters && (
        <div class="card" style="margin-bottom:12px">
          <Field label="Category">
            <select class="input" value={filters.category} onChange={(e) => set('category')(e.currentTarget.value)}>
              <option value="">All categories</option>
              <option value="uncategorized">Uncategorized</option>
              {boot.categories.map((c) => <option value={c.id}>{c.icon} {c.name}{c.archived ? ' (archived)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Account">
            <select class="input" value={filters.account} onChange={(e) => set('account')(e.currentTarget.value)}>
              <option value="">All accounts</option>
              {boot.accounts.map((a) => <option value={a.id}>{a.name}{a.mask ? ` ••${a.mask}` : ''}</option>)}
            </select>
          </Field>
          <div class="row">
            <Field label="From"><input class="input" type="date" value={filters.from} onInput={(e) => set('from')(e.currentTarget.value)} /></Field>
            <Field label="To"><input class="input" type="date" value={filters.to} onInput={(e) => set('to')(e.currentTarget.value)} /></Field>
          </div>
          <button class="btn sm" onClick={() => setFilters({ q: '', status: '', category: '', account: '', from: '', to: '' })}>Clear all filters</button>
        </div>
      )}

      {data && (
        <div class="small muted" style="margin:4px 4px 10px">
          {data.total} transaction{data.total === 1 ? '' : 's'}{data.total ? <> · net <span class="num">{money(data.sum_cents, { sign: true })}</span></> : null}
        </div>
      )}
      {data && data.total === 0 && <div class="card empty"><div class="big">🔍</div>No transactions match.</div>}
      {groups.length > 0 && (
        <div class="card flush">
          {groups.map((g) => (
            <div>
              <div class="day-head"><span>{dayLabel(g.date, boot.today)}</span></div>
              <ul class="list">
                {g.items.map((t) => (
                  <li><TxnRow t={t} selectable={selecting} selected={selected.has(t.id)} onClick={() => (selecting ? toggle(t.id) : setEditing(t))} /></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {data && data.transactions.length < data.total && (
        <button class="btn block" style="margin-top:12px" onClick={() => load(true, offset + 100)}>Show more</button>
      )}

      {!selecting && <button class="fab" aria-label="Add transaction" onClick={() => setEditing({})}><Icon name="plus" /></button>}
      {selecting && (
        <div class="bulkbar">
          <span class="grow small">{selected.size} selected</span>
          <button class="btn sm" disabled={!selected.size} onClick={() => setBulkCat(true)}>Categorize</button>
          <button class="btn sm" disabled={!selected.size} onClick={() => bulk({ excluded: true })}>Exclude</button>
          <button class="btn sm" disabled={!selected.size} onClick={() => bulk({ excluded: false })}>Include</button>
        </div>
      )}
      {bulkCat && <BulkCategory count={selected.size} onClose={() => setBulkCat(false)} onPick={(id) => bulk({ category_id: id })} />}
      {editing && <TxnSheet txn={editing} onClose={() => setEditing(null)} onSaved={saved} onMakeRule={(t) => { setEditing(null); setRuleFor(t); }} />}
      {ruleFor && <RuleSheet rule={{ pattern: ruleFor.merchant, category_id: ruleFor.category_id, bucket_id: ruleFor.bucket_id, match_type: 'contains', apply_existing: true }} onClose={() => setRuleFor(null)} onSaved={() => { setRuleFor(null); load(); }} />}
    </div>
  );
}

function BulkCategory({ count, onClose, onPick }) {
  const { boot } = useApp();
  const [cat, setCat] = useState(null);
  return (
    <Sheet title={`Categorize ${count}`} onClose={onClose} actions={<button class="btn primary sm" onClick={() => onPick(cat)}>Apply</button>}>
      <Field label="New category"><CategorySelect categories={boot.categories} value={cat} onChange={setCat} /></Field>
      <p class="small muted">Your choice is kept even when the bank updates these transactions later.</p>
    </Sheet>
  );
}

export function TxnSheet({ txn, onClose, onSaved, onMakeRule }) {
  const { boot, notify, refresh } = useApp();
  const isNew = !txn.id;
  const manual = isNew || txn.source === 'manual';
  const [kind, setKind] = useState(txn.amount_cents > 0 ? 'in' : 'out');
  const [f, setF] = useState({
    merchant: txn.merchant || '', amount: centsToInput(txn.amount_cents), date: txn.date || boot.today,
    category_id: txn.category_id ?? null, account_id: txn.account_id ?? '', notes: txn.notes || '', excluded: !!txn.excluded, pending: !!txn.pending,
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));

  // Savings buckets: a savings-account transaction is tagged to its buckets (optionally split);
  // money out of any other account can be "paid from" one bucket.
  const tags = txn.buckets || [];
  const [bk, setBk] = useState({
    touched: false, split: tags.length > 1, paidFrom: tags[0]?.kind === 'paid_from',
    rows: tags.length ? tags.map((b) => ({ bucket_id: b.bucket_id, amount: centsToInput(Math.abs(b.amount_cents)) })) : [{ bucket_id: null, amount: '' }],
  });
  const setBucket = (patch) => setBk((x) => ({ ...x, ...patch, touched: true }));
  const setRow = (i, patch) => setBucket({ rows: bk.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const accountId = manual ? (f.account_id ? Number(f.account_id) : null) : txn.account_id;
  const savingsAcct = boot.savings.accounts.find((a) => a.id === accountId && a.buckets.length);
  const isOut = manual ? kind === 'out' : txn.amount_cents < 0;
  const canPayFrom = !savingsAcct && isOut && boot.savings.buckets.length > 0;
  const totalCents = manual ? parseMoney(f.amount) || 0 : Math.abs(txn.amount_cents);
  const splitCents = bk.rows.reduce((s, r) => s + (r.bucket_id ? parseMoney(r.amount) || 0 : 0), 0);
  const bucketsBody = () => {
    if (savingsAcct) {
      if (!bk.split) return bk.rows[0].bucket_id ? [{ bucket_id: bk.rows[0].bucket_id }] : [];
      return bk.rows.filter((r) => r.bucket_id).map((r) => ({ bucket_id: r.bucket_id, amount_cents: parseMoney(r.amount) || 0 }));
    }
    return canPayFrom && bk.paidFrom && bk.rows[0].bucket_id ? [{ bucket_id: bk.rows[0].bucket_id }] : [];
  };
  const save = async () => {
    const cents = parseMoney(f.amount);
    if (manual && (!cents || cents <= 0)) { notify('Enter an amount greater than $0', true); return; }
    setBusy(true);
    try {
      if (canPayFrom && bk.paidFrom && !bk.rows[0].bucket_id) { notify('Pick which savings bucket paid for this', true); return; }
      const body = { merchant: f.merchant, category_id: f.category_id, notes: f.notes, excluded: f.excluded };
      if (bk.touched || (isNew && (savingsAcct || canPayFrom))) body.buckets = bucketsBody();
      if (manual) Object.assign(body, { amount_cents: kind === 'in' ? cents : -cents, date: f.date, account_id: f.account_id ? Number(f.account_id) : null, pending: f.pending });
      const r = isNew ? await api('POST', '/api/transactions', body) : await api('PATCH', `/api/transactions/${txn.id}`, body);
      if (r.alerts?.length) notify(r.alerts[0].title); else notify(isNew ? 'Transaction added' : 'Saved');
      if (r.alerts?.length || body.buckets) refresh();
      onSaved(r.transaction);
    } catch (e) { notify(e.message, true); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!(await ask('Delete this transaction?', { ok: 'Continue', danger: true }))) return;
    await api('DELETE', `/api/transactions/${txn.id}`);
    notify('Deleted');
    onSaved();
  };
  const cat = boot.categories.find((c) => c.id === f.category_id);
  return (
    <Sheet title={isNew ? 'New transaction' : 'Transaction'} onClose={onClose} actions={<button class="btn primary sm" disabled={busy} onClick={save}>Save</button>}>
      {!isNew && (
        <div class="row wrap small muted" style="margin-bottom:12px;gap:6px">
          <span>{txn.source === 'manual' ? 'Added by you' : `From ${txn.account_name || 'your bank'}`}</span>
          {txn.original_name && txn.original_name !== txn.merchant && <span>· “{txn.original_name}”</span>}
          <TxnPills t={txn} />
        </div>
      )}
      {manual ? (
        <>
          <Seg label="Money in or out" value={kind} onChange={setKind} options={[['out', 'Money out'], ['in', 'Money in']]} />
          <div style="height:14px" />
          <Field label="Amount"><MoneyInput value={f.amount} onInput={set('amount')} /></Field>
        </>
      ) : (
        <div class="card" style="margin-bottom:14px">
          <div class={`hero-value num ${txn.amount_cents > 0 ? 'good' : ''}`} style="font-size:28px">{money(txn.amount_cents, { sign: true })}</div>
          <div class="small muted">{dayLabel(txn.date, boot.today)} · {txn.pending ? 'Pending: the amount may change when it posts.' : 'Posted'}</div>
        </div>
      )}
      <Field label="Merchant"><input class="input" value={f.merchant} onInput={(e) => set('merchant')(e.currentTarget.value)} placeholder="e.g. Trader Joe’s" /></Field>
      <Field label="Category" hint={cat?.kind === 'transfer' ? 'Transfers and card payments are left out of spending and income so nothing is counted twice.' : cat?.kind === 'expense' && kind === 'in' && manual ? 'Money in on a spending category counts as a refund and reduces that category’s spending.' : null}>
        <CategorySelect categories={boot.categories} value={f.category_id} onChange={set('category_id')} />
      </Field>
      {manual && (
        <>
          <div class="row">
            <Field label="Date"><input class="input" type="date" value={f.date} onInput={(e) => set('date')(e.currentTarget.value)} /></Field>
          </div>
          <Field label="Account">
            <select class="input" value={f.account_id} onChange={(e) => set('account_id')(e.currentTarget.value)}>
              <option value="">No account</option>
              {boot.accounts.filter((a) => a.source === 'manual').map((a) => <option value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        </>
      )}
      {savingsAcct && (
        <div class="card" style="margin-bottom:14px">
          <Field label={isOut ? 'Take from savings bucket' : 'Add to savings bucket'} hint={bk.split ? `${money(splitCents)} of ${money(totalCents)} assigned${splitCents < totalCents ? `. The other ${money(totalCents - splitCents)} stays not assigned.` : '.'}` : null}>
            {!bk.split ? (
              <BucketSelect savings={boot.savings} accountId={savingsAcct.id} value={bk.rows[0].bucket_id} onChange={(v) => setRow(0, { bucket_id: v })} />
            ) : (
              <div class="stack" style="gap:8px">
                {bk.rows.map((r, i) => (
                  <div class="row" style="gap:8px">
                    <div class="grow"><BucketSelect savings={boot.savings} accountId={savingsAcct.id} value={r.bucket_id} onChange={(v) => setRow(i, { bucket_id: v })} noneLabel="Pick a bucket" /></div>
                    <div style="width:100px;flex:none"><MoneyInput value={r.amount} onInput={(v) => setRow(i, { amount: v })} /></div>
                    {bk.rows.length > 1 && <button class="icon-btn" aria-label="Remove this bucket" onClick={() => setBucket({ rows: bk.rows.filter((_, j) => j !== i) })}><Icon name="x" /></button>}
                  </div>
                ))}
                {bk.rows.length < savingsAcct.buckets.length && <button class="btn sm" onClick={() => setBucket({ rows: [...bk.rows, { bucket_id: null, amount: '' }] })}><Icon name="plus" size={16} />Add another bucket</button>}
              </div>
            )}
          </Field>
          {savingsAcct.buckets.length > 1 && (
            <button class="btn sm" onClick={() => setBucket({ split: !bk.split, rows: bk.split ? [bk.rows[0]] : [{ ...bk.rows[0], amount: bk.rows[0].amount || centsToInput(totalCents) }] })}>
              {bk.split ? 'Use one bucket' : 'Split across buckets'}
            </button>
          )}
        </div>
      )}
      {canPayFrom && (
        <div class="card" style="padding:4px 16px;margin-bottom:14px">
          <Switch label="Paid from savings" hint="Takes it out of a savings bucket. It still counts as spending, but not against this category’s monthly budget." checked={bk.paidFrom} onChange={(v) => setBucket({ paidFrom: v })} />
          {bk.paidFrom && (
            <div style="padding:4px 0 12px">
              <Field label="Which bucket"><BucketSelect savings={boot.savings} value={bk.rows[0].bucket_id} onChange={(v) => setRow(0, { bucket_id: v })} noneLabel="Pick a bucket" /></Field>
            </div>
          )}
        </div>
      )}
      <Field label="Notes"><textarea class="input" value={f.notes} onInput={(e) => set('notes')(e.currentTarget.value)} placeholder="Optional" /></Field>
      <div class="card" style="padding:4px 16px">
        <Switch label="Exclude from budgets and totals" hint="For reimbursed or one-off items you don’t want counted." checked={f.excluded} onChange={set('excluded')} />
        {manual && <Switch label="Pending" hint="Still processing at the bank." checked={f.pending} onChange={set('pending')} />}
      </div>
      {!isNew && (
        <div class="stack" style="margin-top:16px">
          <button class="btn block" onClick={() => onMakeRule({ ...txn, merchant: f.merchant, category_id: f.category_id, bucket_id: savingsAcct && !bk.split ? bk.rows[0].bucket_id : null })}><Icon name="rules" size={18} />Always categorize “{f.merchant}” like this</button>
          {manual && <button class="btn block danger" onClick={del}>Delete transaction</button>}
          {!manual && <p class="tiny muted">Amount and date come from your bank. To leave this out of your totals, turn on Exclude.</p>}
        </div>
      )}
    </Sheet>
  );
}
