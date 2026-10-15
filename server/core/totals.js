// Income / spending math. Every number on the dashboard comes from here.
//
// Rules:
//  - Deleted (removed by the bank) and user-excluded transactions never count.
//  - Categories of kind "transfer" (account transfers, credit-card payments) never count,
//    so moving money between your own accounts is not double counted.
//  - In an expense category, money in (a refund) reduces that category's spending.
//  - In an income category, money out (a clawback) reduces income.
//  - Uncategorized money out counts as spending; uncategorized money in counts as income.
//  - Pending transactions count unless the "include pending" setting is off.
import { periodFor } from './periods.js';

const BASE_WHERE = 't.deleted_at IS NULL AND t.excluded = 0 AND t.date >= ? AND t.date <= ?';

function pendingClause(includePending) {
  return includePending === false ? ' AND t.pending = 0' : '';
}

export function summarize(db, start, end, { includePending = true } = {}) {
  const rows = db.all(
    `SELECT t.category_id AS category_id, c.kind AS kind,
            SUM(t.amount_cents) AS net,
            SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END) AS inflow,
            SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END) AS outflow,
            COUNT(*) AS n
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE ${BASE_WHERE}${pendingClause(includePending)}
     GROUP BY t.category_id`,
    [start, end],
  );
  let income = 0;
  let spending = 0;
  let transfers = 0;
  const byCategory = [];
  for (const r of rows) {
    if (r.kind === 'transfer') { transfers += r.outflow; continue; }
    if (r.kind === 'income') { income += r.net; continue; }
    if (r.kind === 'expense') {
      spending += -r.net;
      byCategory.push({ category_id: r.category_id, spent_cents: -r.net, count: r.n });
      continue;
    }
    // Uncategorized
    income += r.inflow;
    spending += r.outflow;
    if (r.outflow) byCategory.push({ category_id: null, spent_cents: r.outflow, count: r.n });
  }
  byCategory.sort((a, b) => b.spent_cents - a.spent_cents);
  return { start, end, income_cents: income, spending_cents: spending, net_cents: income - spending, transfers_cents: transfers, byCategory };
}

/** Net spending (outflow minus refunds) in one category over a date range. */
export function categorySpent(db, categoryId, start, end, { includePending = true } = {}) {
  const r = db.get(
    `SELECT COALESCE(SUM(t.amount_cents), 0) AS net FROM transactions t
     WHERE t.category_id = ? AND ${BASE_WHERE}${pendingClause(includePending)}`,
    [categoryId, start, end],
  );
  return -r.net;
}

/** Cumulative daily spending for a range, used for the dashboard line chart. */
export function dailySpending(db, start, end, opts = {}) {
  const rows = db.all(
    `SELECT t.date AS date,
            SUM(CASE WHEN c.kind = 'expense' THEN -t.amount_cents
                     WHEN c.kind IS NULL AND t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END) AS spent
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
     WHERE ${BASE_WHERE}${pendingClause(opts.includePending)}
     GROUP BY t.date ORDER BY t.date`,
    [start, end],
  );
  return rows.map((r) => ({ date: r.date, spent_cents: r.spent }));
}

export function listBudgets(db) {
  return db.all(
    `SELECT b.*, c.name, c.icon, c.color, c.kind, c.sort_order, c.archived
     FROM budgets b JOIN categories c ON c.id = b.category_id
     ORDER BY c.sort_order, c.id`,
  );
}

export function budgetStatus(db, budget, asOf, opts = {}) {
  const p = periodFor(budget, asOf);
  const spent = categorySpent(db, budget.category_id, p.start, p.end, opts);
  const amount = budget.amount_cents;
  return {
    category_id: budget.category_id,
    name: budget.name,
    icon: budget.icon,
    color: budget.color,
    period: budget.period,
    amount_cents: amount,
    spent_cents: spent,
    remaining_cents: amount - spent,
    pct: amount > 0 ? spent / amount : 0,
    period_start: p.start,
    period_end: p.end,
    resets_on: p.resetsOn,
    alerts_enabled: !!budget.alerts_enabled,
  };
}

export function allBudgetStatuses(db, asOf, opts = {}) {
  return listBudgets(db)
    .filter((b) => !b.archived && b.amount_cents > 0)
    .map((b) => budgetStatus(db, b, asOf, opts));
}
