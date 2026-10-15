// Date helpers that work on plain "YYYY-MM-DD" strings.
// All arithmetic is done in UTC so daylight-saving changes never shift a day.

const DAY = 86400000;

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function toMs(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function fromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(s, n) {
  return fromMs(toMs(s) + n * DAY);
}

export function diffDays(a, b) {
  return Math.round((toMs(a) - toMs(b)) / DAY);
}

export function daysInMonth(y, m0) {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

export function dayOfWeek(s) {
  return new Date(toMs(s)).getUTCDay();
}

/** Build a date from year, zero-based month (may overflow) and a day clamped to the month length. */
export function clampedDate(y, m0, d) {
  const yy = y + Math.floor(m0 / 12);
  const mm = ((m0 % 12) + 12) % 12;
  return fromMs(Date.UTC(yy, mm, Math.min(d, daysInMonth(yy, mm))));
}

/** Today's date in an IANA time zone, e.g. America/New_York. */
export function todayIn(timeZone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function monthKey(s) {
  return s.slice(0, 7);
}

export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const start = `${ym}-01`;
  const end = clampedDate(y, m - 1, 31);
  return { start, end };
}

export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return clampedDate(y, m - 1 + n, 1).slice(0, 7);
}
