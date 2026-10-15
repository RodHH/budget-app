// Budget threshold alerts.
//
// Each (category, budget period start, threshold) fires at most once. The UNIQUE index on
// alert_events enforces this even if two evaluations race. When a single change crosses
// several thresholds at once (e.g. 70% → 105%) every crossed threshold is recorded but only
// one notification — for the highest — is produced. A refund that drops spending back
// under a threshold does not re-arm it for the same period; the next period starts fresh.
import { allBudgetStatuses } from './totals.js';

export function formatUSD(cents) {
  const neg = cents < 0;
  const v = Math.abs(cents) / 100;
  const s = v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: v % 1 ? 2 : 0 });
  return neg ? `-${s}` : s;
}

export function formatDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function alertMessage(status, threshold) {
  const label = status.period === 'weekly' ? 'this week' : status.period === 'biweekly' ? 'these two weeks' : 'this period';
  const title = threshold >= 100
    ? `${status.icon || ''} ${status.name}: budget ${status.spent_cents > status.amount_cents ? 'exceeded' : 'reached'}`.trim()
    : `${status.icon || ''} ${status.name}: ${threshold}% used`.trim();
  let body = `${formatUSD(status.spent_cents)} of ${formatUSD(status.amount_cents)} spent ${label}.`;
  if (status.remaining_cents < 0) body += ` Over by ${formatUSD(-status.remaining_cents)}.`;
  else body += ` ${formatUSD(status.remaining_cents)} left.`;
  body += ` Resets ${formatDay(status.resets_on)}.`;
  return { title, body };
}

/**
 * Check every current budget period and record newly crossed thresholds.
 * Returns the notifications to deliver (already persisted, notified = 0).
 */
export function evaluateAlerts(db, { asOf, thresholds, includePending = true, now }) {
  const ths = [...new Set((thresholds || []).map(Number).filter((t) => t > 0 && t <= 1000))].sort((a, b) => a - b);
  if (!ths.length) return [];
  const out = [];
  for (const s of allBudgetStatuses(db, asOf, { includePending })) {
    if (!s.alerts_enabled) continue;
    const crossed = ths.filter((t) => s.spent_cents * 100 >= t * s.amount_cents);
    if (!crossed.length) continue;
    const fresh = [];
    for (const t of crossed) {
      const msg = alertMessage(s, t);
      const r = db.run(
        `INSERT OR IGNORE INTO alert_events
           (category_id, period_start, period_end, threshold, spent_cents, budget_cents, title, body, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [s.category_id, s.period_start, s.period_end, t, s.spent_cents, s.amount_cents, msg.title, msg.body, now],
      );
      if (r.changes) fresh.push({ id: r.lastInsertRowid, threshold: t, ...msg });
    }
    if (!fresh.length) continue;
    const top = fresh[fresh.length - 1];
    // Lower thresholds crossed in the same step are recorded but folded into the top alert.
    for (const f of fresh.slice(0, -1)) db.run("UPDATE alert_events SET notified = 1, push_result = 'folded' WHERE id = ?", [f.id]);
    out.push({ id: top.id, category_id: s.category_id, threshold: top.threshold, title: top.title, body: top.body, resets_on: s.resets_on });
  }
  return out;
}
