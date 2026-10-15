// An in-memory stand-in for the Plaid API used by the automated tests and by the
// browser preview. It follows the /transactions/sync contract: cursor-based deltas of
// added / modified / removed, pagination via has_more, pending → posted via
// pending_transaction_id, plus injectable errors. It never touches a real bank.
import { SyncError } from './sync.js';
import { addDays } from './dates.js';

let seq = 0;
const id = (p) => `${p}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class SimulatedPlaid {
  constructor({ env = 'simulated' } = {}) {
    this.env = env;
    this.items = new Map(); // access_token -> item
    this.byPublic = new Map();
    this.calls = [];
    this.webhookKey = null;
  }

  get configured() { return true; }

  _item(token) {
    const it = this.items.get(token);
    if (!it) throw new SyncError('INVALID_ACCESS_TOKEN');
    return it;
  }

  // ---- Plaid API surface ------------------------------------------------------------
  async linkTokenCreate() {
    this.calls.push('linkTokenCreate');
    return { link_token: id('link-sim'), expiration: new Date(Date.now() + 4 * 3600e3).toISOString() };
  }

  async sandboxPublicTokenCreate({ institution_id = 'ins_sim', institution_name = 'Simulated Bank' } = {}) {
    const publicToken = id('public-sim');
    this.byPublic.set(publicToken, { institution_id, institution_name });
    return { public_token: publicToken };
  }

  async publicTokenExchange(publicToken) {
    this.calls.push('publicTokenExchange');
    const info = this.byPublic.get(publicToken);
    if (!info) throw new SyncError('INVALID_PUBLIC_TOKEN');
    this.byPublic.delete(publicToken);
    const access = id('access-sim');
    const item = {
      item_id: id('item'), access_token: access, institution_id: info.institution_id,
      institution_name: info.institution_name, accounts: [], log: [], current: new Map(), history: new Map(), nextErrors: [], mutateDuringPage: 0, pageInProgress: false,
    };
    this.items.set(access, item);
    return { access_token: access, item_id: item.item_id };
  }

  async itemGet(token) {
    const it = this._item(token);
    return { item: { item_id: it.item_id, institution_id: it.institution_id } };
  }

  async institutionsGetById(institutionId) {
    for (const it of this.items.values()) if (it.institution_id === institutionId) return { institution: { name: it.institution_name } };
    return { institution: { name: 'Simulated Bank' } };
  }

  async accountsGet(token) {
    const it = this._item(token);
    return { accounts: it.accounts.map((a) => ({ ...a })), item: { item_id: it.item_id } };
  }

  async itemRemove(token) {
    this._item(token);
    this.items.delete(token);
    return { removed: true };
  }

  async transactionsSync({ access_token, cursor, count = 100 }) {
    this.calls.push('transactionsSync');
    const it = this._item(access_token);
    if (it.nextErrors.length) throw new SyncError(it.nextErrors.shift());
    if (cursor && it.mutateDuringPage > 0 && it.pageInProgress) {
      it.mutateDuringPage--;
      it.pageInProgress = false;
      throw new SyncError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
    }
    const start = cursor ? Number(String(cursor).split(':')[1]) : 0;
    const slice = it.log.slice(start, start + count);
    const end = start + slice.length;
    const out = { added: [], modified: [], removed: [], accounts: it.accounts.map((a) => ({ ...a })), next_cursor: `c:${end}`, has_more: end < it.log.length };
    for (const e of slice) {
      if (e.type === 'removed') out.removed.push({ transaction_id: e.id });
      else out[e.type].push({ ...e.txn });
    }
    it.pageInProgress = out.has_more;
    return out;
  }

  async verifyWebhook() { return true; }

  // ---- Persistence (used by the browser preview to survive reloads) -------------------
  toJSON() {
    return [...this.items.values()].map((it) => ({ ...it, current: [...it.current.entries()], history: [...it.history.entries()] }));
  }

  static fromJSON(items, opts) {
    const p = new SimulatedPlaid(opts);
    for (const it of items || []) p.items.set(it.access_token, { ...it, current: new Map(it.current), history: new Map(it.history) });
    return p;
  }

  // ---- Test / preview helpers -------------------------------------------------------
  addAccount(token, a) {
    const it = this._item(token);
    const acct = {
      account_id: a.account_id || id('acc'), name: a.name, official_name: a.name, mask: a.mask || '0000',
      type: a.type || 'depository', subtype: a.subtype || 'checking',
      balances: { current: a.current ?? 1000, available: a.available ?? a.current ?? 1000, iso_currency_code: 'USD' },
    };
    it.accounts.push(acct);
    return acct;
  }

  /** amount follows Plaid's sign: positive = money out. */
  add(token, t) {
    const it = this._item(token);
    const txn = {
      transaction_id: t.transaction_id || id('txn'), account_id: t.account_id || it.accounts[0].account_id,
      amount: t.amount, date: t.date, authorized_date: t.authorized_date ?? t.date, name: t.name,
      merchant_name: t.merchant_name ?? t.name, pending: !!t.pending, pending_transaction_id: t.pending_transaction_id || null,
      personal_finance_category: t.pfc ? { primary: t.pfc.split('/')[0], detailed: t.pfc.split('/')[1] || t.pfc.split('/')[0] } : null,
      iso_currency_code: 'USD',
    };
    it.log.push({ type: 'added', txn });
    it.current.set(txn.transaction_id, txn);
    it.history.set(txn.transaction_id, txn);
    return txn;
  }

  modify(token, transactionId, changes) {
    const it = this._item(token);
    const txn = { ...it.current.get(transactionId), ...changes };
    it.current.set(transactionId, txn);
    it.log.push({ type: 'modified', txn });
    return txn;
  }

  remove(token, transactionId) {
    const it = this._item(token);
    it.current.delete(transactionId);
    it.log.push({ type: 'removed', id: transactionId });
  }

  /** The bank posts a pending charge: pending id removed, new posted id added. */
  post(token, pendingId, changes = {}, { removeFirst = false } = {}) {
    const it = this._item(token);
    const p = it.current.get(pendingId) || it.history.get(pendingId);
    const stillListed = it.current.has(pendingId);
    const posted = { ...p, ...changes, transaction_id: id('txn'), pending: false, pending_transaction_id: pendingId };
    if (removeFirst && stillListed) this.remove(token, pendingId);
    it.log.push({ type: 'added', txn: posted });
    it.current.set(posted.transaction_id, posted);
    it.history.set(posted.transaction_id, posted);
    if (!removeFirst && stillListed) this.remove(token, pendingId);
    return posted;
  }

  failNext(token, code) { this._item(token).nextErrors.push(code); }
  mutateDuringNextPagination(token) { this._item(token).mutateDuringPage = 1; }

  /** Populate an item with ~2 months of realistic activity ending at `today`. */
  seedRealistic(token, today) {
    const checking = this.addAccount(token, { name: 'Platypus Checking', mask: '0012', current: 4210.55 });
    const card = this.addAccount(token, { name: 'Platypus Rewards Card', mask: '4417', type: 'credit', subtype: 'credit card', current: 612.4, available: 4387.6 });
    const d = (n) => addDays(today, -n);
    for (let back = 56; back >= 0; back -= 14) {
      this.add(token, { account_id: checking.account_id, amount: -2650, date: d(back), name: 'ACME CORP PAYROLL', merchant_name: 'Acme Corp', pfc: 'INCOME/INCOME_WAGES' });
    }
    const spend = [
      ['Starbucks', 5.85, 'FOOD_AND_DRINK/FOOD_AND_DRINK_COFFEE'], ['Whole Foods Market', 84.12, 'FOOD_AND_DRINK/FOOD_AND_DRINK_GROCERIES'],
      ['Chipotle', 14.3, 'FOOD_AND_DRINK/FOOD_AND_DRINK_FAST_FOOD'], ['Shell', 46.2, 'TRANSPORTATION/TRANSPORTATION_GAS'],
      ['Target', 63.75, 'GENERAL_MERCHANDISE/GENERAL_MERCHANDISE_SUPERSTORES'], ['Trader Joe\'s', 52.4, 'FOOD_AND_DRINK/FOOD_AND_DRINK_GROCERIES'],
      ['Uber', 18.6, 'TRANSPORTATION/TRANSPORTATION_TAXIS_AND_RIDE_SHARES'], ['Blue Bottle Coffee', 6.5, 'FOOD_AND_DRINK/FOOD_AND_DRINK_COFFEE'],
    ];
    for (let back = 58; back >= 2; back--) {
      const [name, amt, pfc] = spend[back % spend.length];
      this.add(token, { account_id: card.account_id, amount: +(amt * (0.8 + ((back * 37) % 40) / 100)).toFixed(2), date: d(back), name: name.toUpperCase(), merchant_name: name, pfc });
    }
    for (const back of [45, 15]) {
      this.add(token, { account_id: checking.account_id, amount: 1950, date: d(back), name: 'OAKWOOD APTS RENT', merchant_name: 'Oakwood Apartments', pfc: 'RENT_AND_UTILITIES/RENT_AND_UTILITIES_RENT' });
      this.add(token, { account_id: checking.account_id, amount: 640, date: d(back - 2), name: 'PAYMENT TO REWARDS CARD', merchant_name: null, pfc: 'LOAN_PAYMENTS/LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
      this.add(token, { account_id: card.account_id, amount: -640, date: d(back - 2), name: 'PAYMENT THANK YOU', merchant_name: null, pfc: 'TRANSFER_IN/TRANSFER_IN_ACCOUNT_TRANSFER' });
    }
    this.add(token, { account_id: card.account_id, amount: -24.99, date: d(6), name: 'TARGET REFUND', merchant_name: 'Target', pfc: 'GENERAL_MERCHANDISE/GENERAL_MERCHANDISE_SUPERSTORES' });
    this.add(token, { account_id: card.account_id, amount: 38.4, date: d(1), name: 'SQ *CORNER BISTRO', merchant_name: 'Corner Bistro', pending: true, pfc: 'FOOD_AND_DRINK/FOOD_AND_DRINK_RESTAURANT' });
    this.add(token, { account_id: card.account_id, amount: 5.85, date: d(0), name: 'STARBUCKS STORE 1123', merchant_name: 'Starbucks', pending: true, pfc: 'FOOD_AND_DRINK/FOOD_AND_DRINK_COFFEE' });
    return { checking, card };
  }

  /** Preview helper: post all pending charges (with a tip on restaurants) and add a new pending one. */
  simulateNewActivity(token, today) {
    const it = this._item(token);
    const pend = [...it.current.values()].filter((t) => t.pending);
    for (const p of pend) {
      const tip = /BISTRO|RESTAURANT/i.test(p.name) ? +(p.amount * 0.2).toFixed(2) : 0;
      this.post(token, p.transaction_id, { amount: +(p.amount + tip).toFixed(2), date: today });
    }
    const card = it.accounts.find((a) => a.type === 'credit') || it.accounts[0];
    this.add(token, { account_id: card.account_id, amount: 7.25, date: today, name: 'BLUE BOTTLE COFFEE', merchant_name: 'Blue Bottle Coffee', pending: true, pfc: 'FOOD_AND_DRINK/FOOD_AND_DRINK_COFFEE' });
    return pend.length;
  }
}
