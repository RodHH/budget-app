import { useEffect, useState } from 'preact/hooks';
import { api, centsToInput, money, ordinal, parseMoney, PERIOD_LABEL, WEEKDAYS, weekdayDate } from '../lib.js';
import { BudgetBar, Field, Icon, MoneyInput, Seg, Sheet, StatusTag, Switch, useApp } from '../ui.jsx';

const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#8a5a3c', '#858e89'];
const KINDS = [['expense', 'Spending'], ['income', 'Income'], ['transfer', 'Transfers'], ['archived', 'Archived']];

export function Budgets() {
  const { boot, refresh, route, notify } = useApp();
  const [tab, setTab] = useState('expense');
  const [editing, setEditing] = useState(null);
  const [reorder, setReorder] = useState(false);
  useEffect(() => {
    if (route.query.edit) { const c = boot.categories.find((x) => x.id === Number(route.query.edit)); if (c) setEditing(c); }
  }, []);
  const cats = boot.categories.filter((c) => (tab === 'archived' ? c.archived : !c.archived && c.kind === tab));
  const budgeted = boot.categories.filter((c) => !c.archived && c.status);
  const total = budgeted.reduce((s, c) => s + c.status.amount_cents, 0);
  const spent = budgeted.reduce((s, c) => s + c.status.spent_cents, 0);

  const move = async (i, d) => {
    const ordered = boot.categories.filter((c) => !c.archived).sort((a, b) => a.sort_order - b.sort_order);
    const ids = ordered.map((c) => c.id);
    const a = ids.indexOf(cats[i].id);
    const b = ids.indexOf(cats[i + d].id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    await api('POST', '/api/categories/reorder', { ids: [...ids, ...boot.categories.filter((c) => c.archived).map((c) => c.id)] });
    await refresh();
  };
  const done = async (msg) => { setEditing(null); await refresh(); if (msg) notify(msg); window.dispatchEvent(new Event('bb:data')); };

  return (
    <div>
      <div class="page-head">
        <h1>Budgets</h1>
        <button class="btn sm" onClick={() => setReorder(!reorder)}>{reorder ? 'Done' : 'Reorder'}</button>
      </div>
      {budgeted.length > 0 && tab === 'expense' && (
        <div class="card" style="margin-bottom:12px">
          <div class="row between">
            <div><div class="small muted">Left this period</div><div class={`hero-value num ${total - spent < 0 ? 'crit' : ''}`} style="font-size:28px">{money(total - spent)}</div></div>
            <div class="small muted num" style="text-align:right">{money(spent)} spent<br />of {money(total)}</div>
          </div>
          <BudgetBar status={{ name: 'All budgets', pct: total ? spent / total : 0, spent_cents: spent, amount_cents: total, remaining_cents: total - spent }} />
        </div>
      )}
      <Seg label="Category type" value={tab} onChange={setTab} options={KINDS} />
      {tab === 'transfer' && <p class="small muted" style="margin:12px 4px 0">Anything in these categories is left out of income and spending, so moving money between your accounts or paying a card isn’t counted twice.</p>}
      {tab === 'income' && <p class="small muted" style="margin:12px 4px 0">Money in on these categories counts as income.</p>}
      <div class="card flush" style="margin-top:12px">
        {cats.length === 0 && <div class="empty">{tab === 'archived' ? 'No archived categories.' : 'No categories here yet.'}</div>}
        <ul class="list">
          {cats.map((c, i) => (
            <li class="row" style={reorder ? 'padding-right:8px' : ''}>
              <button class="item grow" onClick={() => !reorder && setEditing(c)} style="flex-direction:column;align-items:stretch;gap:0">
                <div class="row" style="align-items:flex-start">
                  <div class="icon-bubble" style={{ background: `${c.color}22` }}>{c.icon}</div>
                  <div class="grow">
                    <div class="title ellipsis">{c.name}</div>
                    <div class="sub">
                      {c.status ? <>{money(c.status.spent_cents)} of {money(c.budget.amount_cents)} per {PERIOD_LABEL[c.budget.period]} · resets {weekdayDate(c.status.resets_on)}</>
                        : c.kind === 'expense' && !c.archived ? 'No budget · tap to set one' : `${c.txn_count} transaction${c.txn_count === 1 ? '' : 's'}`}
                      {c.budget?.is_sample && <> <span class="pill sample">Sample</span></>}
                    </div>
                  </div>
                  {c.status && (
                    <div class="budget-right">
                      <span class={`amount ${c.status.remaining_cents < 0 ? 'crit' : ''}`}>{c.status.remaining_cents >= 0 ? `${money(c.status.remaining_cents)} left` : `${money(-c.status.remaining_cents)} over`}</span>
                      {!reorder && <StatusTag status={c.status} />}
                    </div>
                  )}
                </div>
                {c.status && !reorder && <BudgetBar status={c.status} />}
              </button>
              {reorder && tab !== 'archived' && (
                <div class="reorder-btns">
                  <button class="icon-btn" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" /></button>
                  <button class="icon-btn" aria-label={`Move ${c.name} down`} disabled={i === cats.length - 1} onClick={() => move(i, 1)}><Icon name="down" /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      {tab !== 'archived' && <button class="btn block" style="margin-top:12px" onClick={() => setEditing({ kind: tab })}><Icon name="plus" size={18} />New category</button>}
      {editing && <CategorySheet cat={editing} onClose={() => setEditing(null)} onDone={done} />}
    </div>
  );
}

function CategorySheet({ cat, onClose, onDone }) {
  const { boot, notify } = useApp();
  const isNew = !cat.id;
  const b = cat.budget || {};
  const [f, setF] = useState({ name: cat.name || '', icon: cat.icon || '🏷️', color: cat.color || COLORS[0], kind: cat.kind || 'expense' });
  const [bud, setBud] = useState({
    on: !!cat.budget, amount: centsToInput(b.amount_cents), period: b.period || 'monthly', reset_day: b.reset_day || 1,
    reset_weekday: b.reset_weekday ?? 1, anchor_date: b.anchor_date || boot.today, alerts_enabled: b.alerts_enabled ?? true,
  });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const setB = (k) => (v) => setBud((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try {
      let id = cat.id;
      if (isNew) id = (await api('POST', '/api/categories', f)).category.id;
      else await api('PATCH', `/api/categories/${id}`, f);
      if (f.kind === 'expense' && bud.on) {
        const cents = parseMoney(bud.amount);
        if (!cents || cents <= 0) { notify('Enter a budget amount above $0', true); return; }
        await api('PUT', `/api/categories/${id}/budget`, { amount_cents: cents, period: bud.period, reset_day: Number(bud.reset_day), reset_weekday: Number(bud.reset_weekday), anchor_date: bud.anchor_date, alerts_enabled: bud.alerts_enabled });
      } else if (cat.budget) {
        await api('DELETE', `/api/categories/${id}/budget`);
      }
      onDone(isNew ? 'Category added' : 'Saved');
    } catch (e) { notify(e.message, true); }
  };
  const archive = async (archived) => {
    await api('PATCH', `/api/categories/${cat.id}`, { archived });
    onDone(archived ? 'Archived. Past transactions keep this category.' : 'Restored');
  };
  return (
    <Sheet title={isNew ? 'New category' : 'Edit category'} onClose={onClose} actions={<button class="btn primary sm" onClick={save}>Save</button>}>
      <div class="row" style="align-items:flex-start">
        <Field label="Icon"><input class="input" style="width:72px;text-align:center;font-size:24px" value={f.icon} maxLength={4} onInput={(e) => set('icon')(e.currentTarget.value)} aria-label="Emoji icon" /></Field>
        <div class="grow"><Field label="Name"><input class="input" value={f.name} onInput={(e) => set('name')(e.currentTarget.value)} placeholder="e.g. Pets" /></Field></div>
      </div>
      <Field label="Color">
        <div class="swatches">{COLORS.map((c) => <button type="button" class="swatch" style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={String(f.color === c)} onClick={() => set('color')(c)} />)}</div>
      </Field>
      <Field label="Type"><Seg label="Type" value={f.kind} onChange={set('kind')} options={[['expense', 'Spending'], ['income', 'Income'], ['transfer', 'Transfer']]} /></Field>

      {f.kind === 'expense' && (
        <div class="card" style="margin-top:4px">
          <Switch label="Spending limit" hint="Track this category against a weekly or monthly amount." checked={bud.on} onChange={setB('on')} />
          {bud.on && (
            <div style="margin-top:12px">
              <Field label="Limit"><MoneyInput value={bud.amount} onInput={setB('amount')} placeholder="300" /></Field>
              <Field label="Resets"><Seg label="Period" value={bud.period} onChange={setB('period')} options={[['weekly', 'Weekly'], ['biweekly', 'Every 2 wks'], ['monthly', 'Monthly']]} /></Field>
              {bud.period === 'monthly' && (
                <Field label="Starts on day" hint="Match it to your payday if you like. Short months use their last day.">
                  <select class="input" value={bud.reset_day} onChange={(e) => setB('reset_day')(e.currentTarget.value)}>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option value={d}>{ordinal(d)} of the month</option>)}
                  </select>
                </Field>
              )}
              {bud.period === 'weekly' && (
                <Field label="Week starts on">
                  <select class="input" value={bud.reset_weekday} onChange={(e) => setB('reset_weekday')(e.currentTarget.value)}>
                    {WEEKDAYS.map((d, i) => <option value={i}>{d}</option>)}
                  </select>
                </Field>
              )}
              {bud.period === 'biweekly' && (
                <Field label="A period starts on" hint="Pick any date a 2-week period begins, like a payday.">
                  <input class="input" type="date" value={bud.anchor_date} onInput={(e) => setB('anchor_date')(e.currentTarget.value)} />
                </Field>
              )}
              <Switch label="Alerts" hint={`Notify me at ${boot.settings.alert_thresholds.map((t) => `${t}%`).join(' and ')} (once each per period).`} checked={bud.alerts_enabled} onChange={setB('alerts_enabled')} />
              {cat.status && <p class="small muted" style="margin:8px 0 0">Current period: {weekdayDate(cat.status.period_start)} – {weekdayDate(cat.status.period_end)}. Resets {weekdayDate(cat.status.resets_on)}.</p>}
            </div>
          )}
        </div>
      )}
      {!isNew && (
        <div class="stack" style="margin-top:16px">
          {cat.archived
            ? <button class="btn block" onClick={() => archive(false)}>Restore category</button>
            : <button class="btn block danger" onClick={() => archive(true)}>Archive category</button>}
          <p class="tiny muted">Archiving hides the category, its budget and its rules from new activity. {cat.txn_count} past transaction{cat.txn_count === 1 ? '' : 's'} keep it.</p>
        </div>
      )}
    </Sheet>
  );
}
