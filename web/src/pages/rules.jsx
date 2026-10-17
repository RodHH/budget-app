import { useState } from 'preact/hooks';
import { api, ask } from '../lib.js';
import { BucketSelect, CategorySelect, Field, Icon, Loading, Seg, Sheet, Switch, useApp, useAsync } from '../ui.jsx';

const MATCH = [['contains', 'Contains'], ['starts_with', 'Starts with'], ['equals', 'Is exactly']];

export function RuleSheet({ rule, onClose, onSaved }) {
  const { boot, notify } = useApp();
  const [f, setF] = useState({ match_type: 'contains', pattern: '', category_id: null, apply_existing: true, enabled: true, ...rule, rename_to: rule.rename_to || '' });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    try {
      const body = { match_type: f.match_type, pattern: f.pattern, category_id: f.category_id, rename_to: f.rename_to || null, bucket_id: f.bucket_id ?? null, apply_existing: f.apply_existing, enabled: f.enabled };
      const r = rule.id ? await api('PATCH', `/api/rules/${rule.id}`, body) : await api('POST', '/api/rules', body);
      notify(r.applied ? `Rule saved and applied to ${r.applied} transaction${r.applied === 1 ? '' : 's'}` : 'Rule saved');
      window.dispatchEvent(new Event('bb:data'));
      onSaved(r.rule);
    } catch (e) { notify(e.message, true); }
  };
  const del = async () => {
    if (!(await ask('Delete this rule? Transactions already categorized keep their category.', { ok: 'Continue', danger: true }))) return;
    await api('DELETE', `/api/rules/${rule.id}`);
    onSaved();
  };
  return (
    <Sheet title={rule.id ? 'Edit rule' : 'New rule'} onClose={onClose} actions={<button class="btn primary sm" onClick={save}>Save</button>}>
      <Field label="When the merchant">
        <Seg label="Match type" value={f.match_type} onChange={set('match_type')} options={MATCH} />
      </Field>
      <Field label="Merchant text" hint="Not case-sensitive. Checked against both the cleaned-up merchant name and the bank’s original description.">
        <input class="input" value={f.pattern} onInput={(e) => set('pattern')(e.currentTarget.value)} placeholder="e.g. Starbucks" />
      </Field>
      <Field label="Set category"><CategorySelect categories={boot.categories} value={f.category_id} onChange={set('category_id')} includeNone /></Field>
      {boot.savings.buckets.length > 0 && (
        <Field label="Add to savings bucket (optional)" hint="For deposits and withdrawals in that bucket’s savings account.">
          <BucketSelect savings={boot.savings} value={f.bucket_id} onChange={set('bucket_id')} noneLabel="No bucket" />
        </Field>
      )}
      <Field label="Rename merchant to (optional)"><input class="input" value={f.rename_to} onInput={(e) => set('rename_to')(e.currentTarget.value)} placeholder="Leave blank to keep the bank’s name" /></Field>
      <div class="card" style="padding:4px 16px">
        <Switch label="Apply to existing transactions" hint="Skips any you categorized by hand." checked={f.apply_existing} onChange={set('apply_existing')} />
        {rule.id && <Switch label="Rule is on" checked={f.enabled} onChange={set('enabled')} />}
      </div>
      {rule.id && <button class="btn block danger" style="margin-top:16px" onClick={del}>Delete rule</button>}
    </Sheet>
  );
}

export function RulesSection() {
  const { data, reload } = useAsync(() => api('GET', '/api/rules'), []);
  const [editing, setEditing] = useState(null);
  if (!data) return <Loading />;
  const move = async (i, d) => {
    const ids = data.rules.map((r) => r.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    await api('POST', '/api/rules/reorder', { ids });
    reload();
  };
  return (
    <div>
      <p class="small muted" style="margin:0 4px 12px">Rules run in order on new transactions, top first. The first matching rule wins. A category you pick by hand always beats a rule.</p>
      <div class="card flush">
        {data.rules.length === 0 && <div class="empty">No rules yet. Open any transaction and tap “Always categorize…”, or add one here.</div>}
        <ul class="list">
          {data.rules.map((r, i) => (
            <li class="row" style="padding-right:8px">
              <button class="item grow" onClick={() => setEditing(r)}>
                <div class="icon-bubble">{r.category_icon || '✏️'}</div>
                <div class="grow">
                  <div class="title ellipsis">{MATCH.find((m) => m[0] === r.match_type)[1]} “{r.pattern}”</div>
                  <div class="sub ellipsis">→ {r.category_name || 'Keep category'}{r.bucket_name ? ` · ${r.bucket_icon || ''} ${r.bucket_name}` : ''}{r.rename_to ? ` · rename to “${r.rename_to}”` : ''}{!r.enabled ? ' · off' : ''}{r.category_archived ? ' · category archived (skipped)' : ''} {r.is_sample ? <span class="pill sample">Sample</span> : null}</div>
                </div>
              </button>
              <div class="reorder-btns">
                <button class="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" /></button>
                <button class="icon-btn" aria-label="Move down" disabled={i === data.rules.length - 1} onClick={() => move(i, 1)}><Icon name="down" /></button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <button class="btn block" style="margin-top:12px" onClick={() => setEditing({})}><Icon name="plus" size={18} />New rule</button>
      {editing && <RuleSheet rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}
