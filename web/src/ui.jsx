import { createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { budgetState, money, weekdayDate } from './lib.js';

export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

// ---------------------------------------------------------------- icons (inline, stroke-based)
const P = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  pie: 'M21 12A9 9 0 1 1 12 3v9z M15 3.5A9 9 0 0 1 20.5 9H15z',
  bank: 'M3 10h18M5 10v8m4-8v8m6-8v8m4-8v8M3 21h18M12 3l9 5H3z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm10 3-5-5',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  ok: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.7 2.7L16 10',
  warn: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  over: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v6M12 16h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
  refresh: 'M20 12a8 8 0 0 1-14.3 4.9M4 12A8 8 0 0 1 18.3 7.1M18 3v4.5h-4.5M6 21v-4.5h4.5',
  rules: 'M4 6h10M4 12h7M4 18h10M17 4l3 3-3 3M17 14l3 3-3 3',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
};
export function Icon({ name, size }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

// ---------------------------------------------------------------- sheet
export function Sheet({ title, onClose, children, actions }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Only autofocus with a mouse; on iPhone it would pop the keyboard over the sheet.
    if (window.matchMedia?.('(pointer: fine)').matches) ref.current?.querySelector('input:not([type=checkbox]), select, textarea')?.focus({ preventScroll: true });
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, []);
  return (
    <div class="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div class="grabber" />
        <div class="sheet-head">
          <button class="btn ghost sm" onClick={onClose}>Cancel</button>
          <h2>{title}</h2>
          <div style="min-width:72px;display:flex;justify-content:flex-end">{actions}</div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }) {
  return (
    <label class="field">
      <span>{label}</span>
      {children}
      {hint && <div class="tiny muted" style="margin-top:6px">{hint}</div>}
    </label>
  );
}

export function Switch({ label, checked, onChange, hint }) {
  return (
    <label class="switch">
      <div class="grow">
        <div>{label}</div>
        {hint && <div class="tiny muted">{hint}</div>}
      </div>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
    </label>
  );
}

export function Seg({ options, value, onChange, label }) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => (
        <button type="button" aria-pressed={String(v === value)} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

export function MoneyInput({ value, onInput, placeholder = '0.00', id }) {
  return (
    <div class="money-input">
      <input id={id} class="input num" inputMode="decimal" autocomplete="off" placeholder={placeholder} value={value} onInput={(e) => onInput(e.currentTarget.value)} />
    </div>
  );
}

export function CategorySelect({ categories, value, onChange, includeNone = true, kinds, id }) {
  const groups = [['expense', 'Spending'], ['income', 'Income'], ['transfer', 'Transfers (not counted)']];
  const active = categories.filter((c) => !c.archived || c.id === value);
  return (
    <select id={id} class="input" value={value ?? ''} onChange={(e) => onChange(e.currentTarget.value ? Number(e.currentTarget.value) : null)}>
      {includeNone && <option value="">Uncategorized</option>}
      {groups.filter(([k]) => !kinds || kinds.includes(k)).map(([k, label]) => (
        <optgroup label={label}>
          {active.filter((c) => c.kind === k).map((c) => <option value={c.id}>{c.icon} {c.name}{c.archived ? ' (archived)' : ''}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------- budget status
export function StatusTag({ status }) {
  const s = budgetState(status);
  if (s === 'over') return <span class="status-tag crit"><Icon name="over" />Over by {money(-status.remaining_cents, { whole: Math.abs(status.remaining_cents) >= 10000 })}</span>;
  if (s === 'warn') return <span class="status-tag warn-text"><Icon name="warn" />{Math.round(status.pct * 100)}% used</span>;
  return <span class="status-tag good"><Icon name="ok" />On track</span>;
}

export function BudgetBar({ status }) {
  const s = budgetState(status);
  const pct = Math.max(0, Math.min(100, status.pct * 100));
  return (
    <div class={`progress ${s === 'over' ? 'over' : s === 'warn' ? 'warn' : ''}`} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(status.pct * 100)} aria-label={`${status.name} budget used`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function BudgetRow({ status, onClick }) {
  const left = status.remaining_cents;
  return (
    <button class="item" onClick={onClick} style="flex-direction:column;align-items:stretch;gap:0">
      <div class="row" style="align-items:flex-start">
        <div class="icon-bubble">{status.icon}</div>
        <div class="grow">
          <div class="title ellipsis">{status.name}</div>
          <div class="small muted num">{money(status.spent_cents)} of {money(status.amount_cents, { whole: status.amount_cents % 100 === 0 })} · resets {weekdayDate(status.resets_on)}</div>
        </div>
        <div class="budget-right">
          <span class={`amount ${left < 0 ? 'crit' : ''}`}>{left >= 0 ? `${money(left)} left` : `${money(-left)} over`}</span>
          <StatusTag status={status} />
        </div>
      </div>
      <BudgetBar status={status} />
    </button>
  );
}

// ---------------------------------------------------------------- transactions
export function TxnPills({ t }) {
  return (
    <>
      {t.pending && <span class="pill"><Icon name="clock" size={11} />Pending</span>}
      {t.excluded && <span class="pill">Excluded</span>}
      {t.category_kind === 'transfer' && <span class="pill">Not counted</span>}
      {t.category_kind === 'expense' && t.amount_cents > 0 && <span class="pill">Refund</span>}
      {t.is_sample && <span class="pill sample">Sample</span>}
      {t.is_sandbox && <span class="pill sandbox">Test data</span>}
    </>
  );
}

export function TxnRow({ t, onClick, selectable, selected }) {
  return (
    <button class="item" onClick={onClick}>
      {selectable && <span class={`check ${selected ? 'on' : ''}`}>{selected && <Icon name="check" />}</span>}
      <div class="icon-bubble">{t.category_icon || '❔'}</div>
      <div class="grow">
        <div class="title ellipsis">{t.merchant}</div>
        <div class="sub ellipsis">
          {t.category_name || 'Uncategorized'}{t.account_name ? ` · ${t.account_name}` : ''} <TxnPills t={t} />
        </div>
      </div>
      <div class={`amount ${t.amount_cents > 0 ? 'in' : ''}`} style={t.excluded || t.category_kind === 'transfer' ? 'opacity:.55' : ''}>
        {money(t.amount_cents, { sign: true })}
      </div>
    </button>
  );
}

export function Toast({ toast }) {
  if (!toast) return null;
  return <div class={`toast ${toast.error ? 'err' : ''}`} role="status">{toast.text}</div>;
}

export function useAsync(fn, deps) {
  const [state, set] = useState({ loading: true, data: null, error: null });
  const reload = async () => {
    try { set((s) => ({ ...s, loading: true })); const data = await fn(); set({ loading: false, data, error: null }); } catch (error) { set({ loading: false, data: null, error }); }
  };
  useEffect(() => { reload(); }, deps);
  return { ...state, reload };
}

export function Loading() {
  return <div class="empty">Loading…</div>;
}
