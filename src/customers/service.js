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

/**
 * Match a customer name from outside the system to a Tally ledger.
 *
 * A purchase order arrives with whatever the customer calls themselves, which
 * is rarely byte-identical to their ledger name — "Ashok Auto Works." against
 * "Ashok Auto Works", "SANGHVI INDUSTRIES PVT. LTD." against "Sanghvi
 * Industries Pvt Ltd". Nothing is matched on a guess: an unmatched name still
 * produces an order, flagged, because a purchase order that quietly goes
 * missing is far worse than one that needs a moment of attention.
 */
// Only true legal forms. "Industries", "Enterprises" and "Company" are part of
// the actual name here — Sanghvi Industries and Sanghvi Motors are different
// firms — and stripping them would match orders onto the wrong ledger, which
// means the wrong credit position against the wrong customer.
const LEGAL_SUFFIXES = /\b(pvt|private|ltd|limited|llp|inc|incorporated|corp)\b/gi;

function normaliseCompany(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchCustomer(name) {
  const given = String(name || '').trim();
  if (!given) return { matched: false, name: '', guid: null, method: 'none' };

  const ledgers = db
    .prepare('SELECT guid, name FROM tally_ledgers WHERE is_customer = 1')
    .all();

  const exact = ledgers.find((l) => l.name.toLowerCase() === given.toLowerCase());
  if (exact) return { matched: true, name: exact.name, guid: exact.guid, method: 'exact' };

  const key = normaliseCompany(given);
  if (key) {
    const hits = ledgers.filter((l) => normaliseCompany(l.name) === key);
    // Only a single candidate counts. Two ledgers that normalise the same way
    // is a question for a person, not something to pick between.
    if (hits.length === 1) {
      return { matched: true, name: hits[0].name, guid: hits[0].guid, method: 'normalised' };
    }
    if (hits.length > 1) {
      return { matched: false, name: given, guid: null, method: 'ambiguous', candidates: hits.map((h) => h.name) };
    }
  }

  return { matched: false, name: given, guid: null, method: 'unmatched' };
}
