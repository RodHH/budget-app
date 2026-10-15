import { useState } from 'preact/hooks';
import { api, money, monthLabel, shiftMonth, timeAgo, ask } from '../lib.js';
import { CategoryBars, SpendingLine } from '../charts.jsx';
import { BudgetRow, Icon, Loading, TxnRow, useApp, useAsync } from '../ui.jsx';

export function SampleBanner() {
  const { boot, refresh, notify } = useApp();
  if (!boot.has_sample) return null;
  const remove = async () => {
    if (!(await ask('Remove all sample accounts, transactions, budgets and rules? Your own data is not touched.', { ok: 'Continue', danger: true }))) return;
    await api('POST', '/api/sample/remove');
    await refresh();
    notify('Sample data removed');
    window.dispatchEvent(new Event('bb:data'));
  };
  return (
    <div class="banner sample small">
      <span aria-hidden="true">🧪</span>
      <div class="grow"><b>Sample data is showing</b>Items marked “Sample” are made up, for trying the app.</div>
      <button class="btn sm" onClick={remove}>Remove</button>
    </div>
  );
}

export function Dashboard() {
  const { boot, navigate, refresh } = useApp();
  const [month, setMonth] = useState(boot.today.slice(0, 7));
  const { data: d, loading, reload } = useAsync(() => api('GET', `/api/dashboard?month=${month}`), [month]);
  if (!d) return <Loading />;
  const markRead = async () => { await api('POST', '/api/alerts/read-all'); await refresh(); reload(); };
  const hasAnything = d.recent.length > 0;
  const sandbox = d.connections.find((c) => c.environment !== 'production');
  const lastSync = d.connections.map((c) => c.last_success_at).filter(Boolean).sort().at(-1);
  const spentPrevSamePoint = d.daily.previous[Math.min(d.daily.current.length, d.daily.previous.length) - 1] || 0;
  const delta = d.is_current_month && d.daily.current.length ? d.spending_cents - spentPrevSamePoint : null;

  return (
    <div>
      <div class="page-head">
        <button class="icon-btn" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}><Icon name="left" /></button>
        <h1 style="font-size:22px">{monthLabel(month)}</h1>
        <button class="icon-btn" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))} disabled={d.is_current_month} style={d.is_current_month ? 'opacity:.3' : ''}><Icon name="right" /></button>
      </div>

      <SampleBanner />
      {sandbox && <div class="banner small"><span class="pill sandbox">Test data</span><div class="grow">Includes transactions from {sandbox.environment === 'simulated' ? 'a simulated test bank' : 'a Plaid Sandbox test bank'}, not a real account.</div></div>}
      {d.alerts.length > 0 && (
        <div class="banner alert small">
          <Icon name="bell" size={18} />
          <div class="grow">
            {d.alerts.slice(0, 3).map((a) => <div><b style="display:inline">{a.title}</b> <span>{a.body}</span></div>)}
          </div>
          <button class="btn sm" onClick={markRead}>Dismiss</button>
        </div>
      )}

      {!hasAnything && (
        <div class="card empty">
          <div class="big">🌱</div>
          <p><b>Your budget is empty.</b><br />Add a transaction, set a budget, or connect a bank.</p>
          <div class="row wrap" style="justify-content:center">
            <a class="btn primary" href="#/transactions?new=1">Add transaction</a>
            <a class="btn" href="#/budgets">Set budgets</a>
            <a class="btn" href="#/more?section=data">Try sample data</a>
          </div>
        </div>
      )}

      {hasAnything && (
        <>
          <div class="card">
            <div class="small muted">{d.budgets.length ? 'Left across all budgets' : 'Spent this month'}</div>
            {d.budgets.length ? (
              <>
                <div class={`hero-value num ${d.budget_remaining_cents < 0 ? 'crit' : ''}`}>{money(d.budget_remaining_cents)}</div>
                <div class="small muted num">{money(d.budget_spent_cents)} spent of {money(d.budget_total_cents)} budgeted in each budget’s current period</div>
              </>
            ) : <div class="hero-value num">{money(d.spending_cents)}</div>}
          </div>
          <div class="grid-3" style="margin-top:10px">
            <div class="card stat"><div class="label">Income</div><div class="value num good">{money(d.income_cents, { whole: d.income_cents >= 100000 })}</div></div>
            <div class="card stat"><div class="label">Spending</div><div class="value num">{money(d.spending_cents, { whole: d.spending_cents >= 100000 })}</div></div>
            <div class="card stat"><div class="label">Net</div><div class={`value num ${d.net_cents < 0 ? 'crit' : ''}`}>{money(d.net_cents, { sign: true, whole: Math.abs(d.net_cents) >= 100000 })}</div></div>
          </div>
          <p class="tiny muted" style="margin:8px 4px 0">Transfers between your accounts and credit-card payments ({money(d.transfers_cents)} this month) are not counted as spending or income.</p>

          {d.budgets.length > 0 && (
            <>
              <div class="section-title">Budgets</div>
              <div class="card flush"><ul class="list">{d.budgets.map((b) => <li><BudgetRow status={b} onClick={() => navigate('budgets', { edit: b.category_id })} /></li>)}</ul></div>
            </>
          )}

          <div class="section-title">Spending pace</div>
          <div class="card">
            {delta !== null && (
              <div class="small" style="margin-bottom:8px">
                {delta > 0 ? <span>You’ve spent <b class="num">{money(delta)}</b> more than at this point last month.</span>
                  : <span>You’ve spent <b class="num">{money(-delta)}</b> less than at this point last month.</span>}
              </div>
            )}
            <SpendingLine current={d.daily.current} previous={d.daily.previous} month={month} prevMonthLabel={monthLabel(d.previous.month).split(' ')[0]} />
          </div>

          {d.by_category.length > 0 && (
            <>
              <div class="section-title">Where it went</div>
              <div class="card">
                <CategoryBars rows={d.by_category.slice(0, 7)} total={d.spending_cents} onPick={(r) => navigate('transactions', { category: r.category_id ?? 'uncategorized', from: d.range.start, to: d.range.end })} />
              </div>
            </>
          )}

          <div class="section-title row between"><span>Recent</span><a class="small" href="#/transactions" style="text-transform:none;letter-spacing:0">See all</a></div>
          <div class="card flush"><ul class="list">{d.recent.map((t) => <li><TxnRow t={t} onClick={() => navigate('transactions', { open: t.id })} /></li>)}</ul></div>
          {d.counts.uncategorized > 0 && (
            <a class="banner small" href={`#/transactions?status=uncategorized&from=${d.range.start}&to=${d.range.end}`} style="margin-top:12px;text-decoration:none;color:inherit">
              <span>❔</span><div class="grow">{d.counts.uncategorized} uncategorized transaction{d.counts.uncategorized === 1 ? '' : 's'} this month. Tap to review.</div>
            </a>
          )}
        </>
      )}

      <p class="tiny muted" style="margin:20px 4px">
        {d.connections.length > 0 ? <>Bank data last updated {timeAgo(lastSync)}. </> : null}
        Banks can take hours (sometimes a day or more) to report purchases, so totals may lag. Alerts tell you after the fact; they can’t block a purchase.
        {loading ? ' Refreshing…' : ''}
      </p>
    </div>
  );
}
