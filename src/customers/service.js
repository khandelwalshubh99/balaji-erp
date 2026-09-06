/**
 * Customers, as Tally knows them.
 *
 * Read-only: parties are created in Tally, never here. Quotations and orders
 * both need this, so it does not belong inside either of them.
 */
import { db } from '../db/index.js';
import { config } from '../config.js';

export function listCustomers(search = '') {
  const params = {};
  let clause = 'is_customer = 1';
  if (search) {
    clause += ' AND name LIKE @q';
    params.q = `%${search}%`;
  }
  return db
    .prepare(`SELECT guid, name, outstanding, credit_limit, credit_period_days, phone, state, gstin
              FROM tally_ledgers WHERE ${clause} ORDER BY name LIMIT 400`)
    .all(params);
}

/**
 * A customer's credit picture, from the synced ledger and open bills.
 *
 * `commitmentValue` is an order or quotation being considered, so callers can
 * ask "and where would this leave them" in one place rather than each doing
 * the arithmetic differently.
 */
export function customerCredit(name, commitmentValue = 0) {
  const ledger = db.prepare('SELECT * FROM tally_ledgers WHERE name = ? AND is_customer = 1').get(name);
  if (!ledger) return null;

  const bills = db.prepare('SELECT bill_date, due_date, amount FROM tally_bills WHERE party_name = ?').all(name);
  const today = new Date();
  const overdue = bills
    .filter((b) => b.due_date && new Date(`${b.due_date}T00:00:00`) < today)
    .reduce((s, b) => s + b.amount, 0);

  const outstanding = ledger.outstanding;
  const creditLimit = ledger.credit_limit;
  const exposureAfter = outstanding + (Number(commitmentValue) || 0);

  return {
    name: ledger.name,
    guid: ledger.guid,
    outstanding,
    creditLimit,
    creditPeriodDays: ledger.credit_period_days || config.rules.defaultCreditPeriodDays,
    overdue,
    openBills: bills.length,
    overLimit: creditLimit > 0 && outstanding > creditLimit,
    exposureAfter,
    wouldExceedLimit: creditLimit > 0 && exposureAfter > creditLimit,
    // A single word for the snapshot stored against an order.
    status:
      creditLimit > 0 && exposureAfter > creditLimit
        ? 'over_limit'
        : overdue > 0
        ? 'has_overdue'
        : 'within',
  };
}
