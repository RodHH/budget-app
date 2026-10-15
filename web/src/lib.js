// API client + formatting helpers.

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-bb': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'Can’t reach the server. Check your connection.');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && data?.error === 'unauthenticated') window.dispatchEvent(new Event('bb:signed-out'));
    throw new ApiError(res.status, data?.error, data?.message || 'Something went wrong.');
  }
  return data;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function money(cents, { sign = false, whole = false } = {}) {
  if (cents === null || cents === undefined) return '—';
  const f = whole ? usd0 : usd;
  const s = f.format(Math.abs(cents) / 100);
  if (cents < 0) return `−${s}`;
  if (sign && cents > 0) return `+${s}`;
  return s;
}

export function compactMoney(cents) {
  const v = cents / 100;
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(v)}`;
}

/** "12.34" or "$1,234" → cents (integer). Returns null when not a number. */
export function parseMoney(str) {
  if (typeof str === 'number') return Math.round(str * 100);
  const clean = String(str || '').replace(/[$,\s]/g, '');
  if (!/^-?\d*(\.\d{0,2})?$/.test(clean) || clean === '' || clean === '-' || clean === '.') return null;
  return Math.round(parseFloat(clean) * 100);
}

export function centsToInput(cents) {
  if (cents === null || cents === undefined) return '';
  return (Math.abs(cents) / 100).toFixed(2).replace(/\.00$/, '');
}

const dUTC = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

export function dayLabel(date, today) {
  if (date === today) return 'Today';
  const diff = Math.round((dUTC(today) - dUTC(date)) / 864e5);
  if (diff === 1) return 'Yesterday';
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return dUTC(date).toLocaleDateString('en-US', { weekday: diff < 7 && diff > 0 ? 'long' : undefined, month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', timeZone: 'UTC' });
}

export function shortDate(date) {
  return dUTC(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function weekdayDate(date) {
  return dUTC(date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function budgetState(status) {
  if (!status) return null;
  if (status.spent_cents > status.amount_cents) return 'over';
  if (status.pct >= 0.8) return 'warn';
  return 'ok';
}

export const PERIOD_LABEL = { weekly: 'week', biweekly: '2 weeks', monthly: 'month' };
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function storage(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

/** In-page confirmation dialog (native confirm() is unavailable in some embedded views). */
export function ask(message, { ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    const box = document.createElement('div');
    box.className = 'sheet';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    const p = document.createElement('p');
    p.style.whiteSpace = 'pre-line';
    p.textContent = message;
    const row = document.createElement('div');
    row.className = 'stack';
    const yes = document.createElement('button');
    yes.className = `btn block ${danger ? 'danger' : 'primary'}`;
    yes.textContent = ok;
    const no = document.createElement('button');
    no.className = 'btn block';
    no.textContent = 'Cancel';
    row.append(yes, no);
    box.append(p, row);
    scrim.append(box);
    const done = (v) => { scrim.remove(); resolve(v); };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    scrim.onclick = (e) => { if (e.target === scrim) done(false); };
    document.body.append(scrim);
    yes.focus();
  });
}
