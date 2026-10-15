// Default categories and the mapping from Plaid's personal_finance_category to them.

export const DEFAULT_CATEGORIES = [
  { key: 'paycheck', name: 'Paycheck', kind: 'income', icon: '💼', color: '#1baf7a' },
  { key: 'other_income', name: 'Other income', kind: 'income', icon: '💵', color: '#008300' },
  { key: 'housing', name: 'Rent & mortgage', kind: 'expense', icon: '🏠', color: '#2a78d6' },
  { key: 'utilities', name: 'Utilities', kind: 'expense', icon: '💡', color: '#eda100' },
  { key: 'groceries', name: 'Groceries', kind: 'expense', icon: '🛒', color: '#1baf7a' },
  { key: 'restaurants', name: 'Restaurants', kind: 'expense', icon: '🍽️', color: '#eb6834' },
  { key: 'coffee', name: 'Coffee', kind: 'expense', icon: '☕', color: '#8a5a3c' },
  { key: 'transportation', name: 'Transportation', kind: 'expense', icon: '🚗', color: '#6250d6' },
  { key: 'shopping', name: 'Shopping', kind: 'expense', icon: '🛍️', color: '#e87ba4' },
  { key: 'subscriptions', name: 'Subscriptions', kind: 'expense', icon: '📺', color: '#2a78d6' },
  { key: 'entertainment', name: 'Entertainment', kind: 'expense', icon: '🎬', color: '#6250d6' },
  { key: 'health', name: 'Health', kind: 'expense', icon: '🩺', color: '#e34948' },
  { key: 'personal_care', name: 'Personal care', kind: 'expense', icon: '💇', color: '#e87ba4' },
  { key: 'travel', name: 'Travel', kind: 'expense', icon: '✈️', color: '#2a78d6' },
  { key: 'home', name: 'Home & garden', kind: 'expense', icon: '🛠️', color: '#008300' },
  { key: 'gifts', name: 'Gifts & donations', kind: 'expense', icon: '🎁', color: '#e34948' },
  { key: 'fees', name: 'Fees & charges', kind: 'expense', icon: '🏦', color: '#858e89' },
  { key: 'loan', name: 'Loan payments', kind: 'expense', icon: '🧾', color: '#858e89' },
  { key: 'other', name: 'Other spending', kind: 'expense', icon: '📦', color: '#858e89' },
  { key: 'transfer', name: 'Transfers', kind: 'transfer', icon: '🔁', color: '#858e89' },
  { key: 'cc_payment', name: 'Credit card payments', kind: 'transfer', icon: '💳', color: '#858e89' },
];

export function seedCategories(db, now) {
  const exists = db.get('SELECT COUNT(*) n FROM categories').n;
  if (exists) return;
  db.tx(() => {
    DEFAULT_CATEGORIES.forEach((c, i) => {
      db.run(
        'INSERT INTO categories (name, kind, icon, color, sort_order, system_key, created_at) VALUES (?,?,?,?,?,?,?)',
        [c.name, c.kind, c.icon, c.color, i, c.key, now],
      );
    });
  });
}

// Plaid personal_finance_category: detailed values checked first, then primary.
const DETAILED = {
  FOOD_AND_DRINK_COFFEE: 'coffee',
  FOOD_AND_DRINK_GROCERIES: 'groceries',
  RENT_AND_UTILITIES_RENT: 'housing',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'housing',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'cc_payment',
  TRANSFER_IN_ACCOUNT_TRANSFER: 'transfer',
  TRANSFER_OUT_ACCOUNT_TRANSFER: 'transfer',
  INCOME_WAGES: 'paycheck',
  ENTERTAINMENT_TV_AND_MOVIES: 'subscriptions',
  GENERAL_SERVICES_SUBSCRIPTION: 'subscriptions',
};
const PRIMARY = {
  INCOME: 'other_income',
  TRANSFER_IN: 'transfer',
  TRANSFER_OUT: 'transfer',
  LOAN_PAYMENTS: 'loan',
  BANK_FEES: 'fees',
  ENTERTAINMENT: 'entertainment',
  FOOD_AND_DRINK: 'restaurants',
  GENERAL_MERCHANDISE: 'shopping',
  HOME_IMPROVEMENT: 'home',
  MEDICAL: 'health',
  PERSONAL_CARE: 'personal_care',
  GENERAL_SERVICES: 'other',
  GOVERNMENT_AND_NON_PROFIT: 'gifts',
  TRANSPORTATION: 'transportation',
  TRAVEL: 'travel',
  RENT_AND_UTILITIES: 'utilities',
};

export function systemKeyForPlaid(pfc) {
  if (!pfc) return null;
  return DETAILED[pfc.detailed] || PRIMARY[pfc.primary] || null;
}

/** Category id for a system key, skipping archived categories. */
export function categoryIdForKey(db, key) {
  if (!key) return null;
  const row = db.get('SELECT id FROM categories WHERE system_key = ? AND archived = 0', [key]);
  return row ? row.id : null;
}
