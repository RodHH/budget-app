// Merchant rules: "Starbucks → Coffee". Matching is case-insensitive and looks at both
// the display merchant and the bank's original description.

export const MATCH_TYPES = ['contains', 'equals', 'starts_with'];

export function loadRules(db) {
  return db.all(
    `SELECT r.* FROM rules r LEFT JOIN categories c ON c.id = r.category_id
     WHERE r.enabled = 1 AND (r.category_id IS NULL OR c.archived = 0)
     ORDER BY r.sort_order, r.id`,
  );
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function ruleMatches(rule, txn) {
  const p = norm(rule.pattern);
  if (!p) return false;
  return [txn.merchant, txn.original_name].some((v) => {
    const h = norm(v);
    if (!h) return false;
    if (rule.match_type === 'equals') return h === p;
    if (rule.match_type === 'starts_with') return h.startsWith(p);
    return h.includes(p);
  });
}

export function findRule(rules, txn) {
  return rules.find((r) => ruleMatches(r, txn)) || null;
}
