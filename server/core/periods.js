import { addDays, clampedDate, dayOfWeek, diffDays } from './dates.js';

export const PERIODS = ['weekly', 'biweekly', 'monthly'];
const DEFAULT_ANCHOR = '2024-01-07'; // a Sunday

/**
 * Return the budget period that contains `date`.
 *  weekly:   starts on `reset_weekday` (0 = Sunday … 6 = Saturday)
 *  biweekly: 14-day cycles counted from `anchor_date`
 *  monthly:  starts on `reset_day` (1–31); short months clamp to their last day
 * Result: { start, end, resetsOn } where end is inclusive and resetsOn = end + 1 day.
 */
export function periodFor(budget, date) {
  const period = budget.period || 'monthly';
  if (period === 'weekly') {
    const w = Number.isInteger(budget.reset_weekday) ? budget.reset_weekday : 0;
    const start = addDays(date, -((dayOfWeek(date) - w + 7) % 7));
    return { start, end: addDays(start, 6), resetsOn: addDays(start, 7) };
  }
  if (period === 'biweekly') {
    const anchor = budget.anchor_date || DEFAULT_ANCHOR;
    const k = Math.floor(diffDays(date, anchor) / 14);
    const start = addDays(anchor, 14 * k);
    return { start, end: addDays(start, 13), resetsOn: addDays(start, 14) };
  }
  const day = Math.min(Math.max(parseInt(budget.reset_day, 10) || 1, 1), 31);
  const y = Number(date.slice(0, 4));
  const m0 = Number(date.slice(5, 7)) - 1;
  let startMonth = m0;
  let start = clampedDate(y, m0, day);
  if (start > date) {
    startMonth = m0 - 1;
    start = clampedDate(y, startMonth, day);
  }
  const resetsOn = clampedDate(y, startMonth + 1, day);
  return { start, end: addDays(resetsOn, -1), resetsOn };
}

export function describeSchedule(budget) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (budget.period === 'weekly') return `Weekly, resets ${days[budget.reset_weekday ?? 0]}`;
  if (budget.period === 'biweekly') return `Every 2 weeks from ${budget.anchor_date || DEFAULT_ANCHOR}`;
  const d = budget.reset_day || 1;
  return d === 1 ? 'Monthly, resets on the 1st' : `Monthly, resets on day ${d}`;
}
