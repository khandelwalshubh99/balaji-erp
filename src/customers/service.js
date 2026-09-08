/**
 * Customers, as Tally knows them — plus the one thing it does not.
 *
 * Parties are created in Tally, never here, so everything read out of
 * `tally_ledgers` below is read-only. The exception is the industry segment at
 * the bottom of this file: Tally has nowhere to put "this customer is a
 * pharmaceuticals plant", so that is the app's own record and is written here.
 *
 * Quotations and orders both need this, so it does not belong inside either.
 */
import { db } from '../db/index.js';
import { config } from '../config.js';
import { queue } from '../sheets/store.js';

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


// --- Industry segment -------------------------------------------------------
/**
 * What industry a customer is in — pharmaceuticals, chemical, automobile, food
 * and agro, and whatever else turns up next.
 *
 * This is NOT the tier. A tier is worked out from what a customer buys and is
 * recalculated every time the screen loads; a segment is a fact about the
 * customer that somebody types in once and that no amount of trading history
 * would ever reveal. The two answer different questions — "how much is this
 * customer worth" against "who are we actually selling to" — and the second is
 * the one that says whether a bad month is this customer or the whole of pharma.
 */

/**
 * A starting list, not the list.
 *
 * Offered in the dropdown so the common ones are one click rather than typed
 * eight different ways ("Automobile", "Auto", "automotive"), which is the
 * failure that makes a free-text field useless for grouping. Anything not here
 * can still be typed, and once typed it joins the list for everyone.
 */
export const SUGGESTED_SEGMENTS = [
  'Pharmaceuticals',
  'Chemical',
  'Automobile',
  'Food and Agro',
  'Engineering and Fabrication',
  'Textiles',
  'Plastics and Packaging',
  'Cement and Construction',
  'Power and Electrical',
  'Trader / Reseller',
  'Government and PSU',
];

/** Every segment on the screen: the suggestions, plus whatever is in use. */
export function knownSegments() {
  const inUse = db
    .prepare(`SELECT segment, COUNT(*) AS customers FROM customer_segments
              WHERE TRIM(segment) <> '' GROUP BY segment ORDER BY segment`)
    .all();
  const names = new Set(inUse.map((r) => r.segment));
  return {
    inUse,
    // Suggestions already in use are not offered twice.
    suggested: SUGGESTED_SEGMENTS.filter((s) => !names.has(s)),
    all: [...new Set([...inUse.map((r) => r.segment), ...SUGGESTED_SEGMENTS])].sort(),
  };
}

/** customer name -> segment, for anything that needs to group by it. */
export function segmentByCustomer() {
  return new Map(
    db
      .prepare(`SELECT customer_name, segment FROM customer_segments WHERE TRIM(segment) <> ''`)
      .all()
      .map((r) => [r.customer_name, r.segment])
  );
}

export function listCustomerSegments() {
  return db.prepare('SELECT * FROM customer_segments ORDER BY customer_name').all();
}

/**
 * Assign a customer to an industry, or clear it.
 *
 * An empty segment deletes the row rather than storing a blank one, so
 * "unassigned" is the absence of a record and there is only one way to spell it.
 * The customer name is checked against the ledgers: a segment filed under a
 * misspelt name would never match a sales voucher and would sit there looking
 * like the work had been done.
 */
export function setCustomerSegment(customerName, segment, actor) {
  const name = String(customerName || '').trim();
  if (!name) throw new Error('A customer is required.');

  const ledger = db.prepare('SELECT guid FROM tally_ledgers WHERE name = ? AND is_customer = 1').get(name);
  if (!ledger) throw new Error(`'${name}' is not a customer in the synced ledgers.`);

  const value = String(segment || '').trim();
  const existing = db.prepare('SELECT id FROM customer_segments WHERE customer_name = ?').get(name);

  if (!value) {
    if (existing) {
      db.prepare('DELETE FROM customer_segments WHERE id = ?').run(existing.id);
      queue('customer_segments', existing.id, 'delete');
    }
    return { customerName: name, segment: null };
  }

  const info = db
    .prepare(`
      INSERT INTO customer_segments (customer_name, customer_guid, segment, updated_by)
      VALUES (@name, @guid, @segment, @actor)
      ON CONFLICT(customer_name) DO UPDATE SET
        segment = excluded.segment,
        customer_guid = excluded.customer_guid,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')`)
    .run({ name, guid: ledger.guid, segment: value, actor: actor?.id || null });

  const id = existing ? existing.id : info.lastInsertRowid;
  queue('customer_segments', id);
  return { customerName: name, segment: value, id };
}
