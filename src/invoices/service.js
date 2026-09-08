/**
 * Invoices, and the payment clock that is deliberately not here.
 *
 * THE APP DOES NOT RUN A PAYMENT CLOCK, AND WILL NOT.
 * Whether a bill is paid, part paid or overdue is asked of Tally every time it
 * is displayed, never stored here. That is the single most important decision
 * in this file. A local `paid` flag is wrong the moment somebody receipts a
 * cheque in Tally without telling anyone, and a dashboard that chases a
 * customer who paid last Tuesday costs more goodwill than the dashboard is
 * worth. Tally is where money is recorded; this holds a LINK to the bill and
 * reads the answer from it.
 *
 * WE DO NOT MINT INVOICE NUMBERS EITHER.
 * The tax invoice is a statutory document raised in Tally, and its number
 * belongs to Tally's GST sequence. Issuing our own BE/INV series here would
 * create a second sequence that disagrees with the filed one — the sort of
 * disagreement that is discovered by a tax officer rather than by us. So the
 * number is TYPED IN from the invoice that was raised, and this then goes
 * looking for the matching bill.
 *
 * WHICH MAKES THE MATCH THE WHOLE JOB.
 * An invoice with no bill behind it is not tidied away or guessed at. It sits
 * in a queue saying so, because it means one of two things and both are worth
 * knowing: the invoice has not actually been raised in Tally, or it was raised
 * against a different party than the order says. Neither improves by being
 * hidden.
 */
import { db } from '../db/index.js';
import { config } from '../config.js';
import { queue } from '../sheets/store.js';
import { todayISO } from '../lib/dates.js';

const dayNumber = (iso) => Math.floor(new Date(`${String(iso).slice(0, 10)}T00:00:00`).getTime() / 86400000);
const daysSince = (iso) => (iso ? dayNumber(todayISO()) - dayNumber(iso) : 0);

/**
 * A bill reference, reduced to what can safely be compared.
 *
 * Case and spacing only. Nothing clever: no stripping of slashes, no ignoring
 * of leading zeros, no fuzzy distance. `BE/2627/0012` and `BE/2627/012` are
 * different bills, and an ERP that decides otherwise will one day chase the
 * wrong customer for the wrong money with complete confidence.
 */
const normalise = (ref) => String(ref || '').toUpperCase().replace(/\s+/g, '');

function logEvent(invoiceId, orderId, to, actor, note) {
  const info = db.prepare(
    `INSERT INTO pipeline_events (entity_type, entity_id, order_id, from_stage, to_stage, note, actor_id, actor_name)
     VALUES ('invoice', ?, ?, NULL, ?, ?, ?, ?)`
  ).run(invoiceId, orderId, to, note || null, actor?.id || null, actor?.name || null);
  queue('pipeline_events', info.lastInsertRowid);
}

// --- Raising ----------------------------------------------------------------

/**
 * What a dispatch is worth, at the rates on the order it came from.
 *
 * Offered as the invoice amount and nothing more. The figure that matters is
 * the one on the document Tally produced, so this is a starting point for
 * whoever is typing, not a number to be trusted over the invoice itself.
 */
export function valueOfDispatch(dispatchId) {
  const rows = db
    .prepare(`
      SELECT dl.qty_dispatched AS qty, ol.rate, ol.gst_rate
      FROM dispatch_lines dl JOIN order_lines ol ON ol.id = dl.order_line_id
      WHERE dl.dispatch_id = ?`)
    .all(dispatchId);
  const freight = db.prepare('SELECT freight_amount FROM dispatches WHERE id = ?').get(dispatchId)?.freight_amount || 0;
  const taxable = rows.reduce((n, r) => n + r.qty * (r.rate || 0), 0);
  const tax = rows.reduce((n, r) => n + (r.qty * (r.rate || 0) * (r.gst_rate || 0)) / 100, 0);
  return { taxable, tax, freight, total: Math.round((taxable + tax + freight) * 100) / 100 };
}

/**
 * Record an invoice raised in Tally.
 *
 * Against a dispatch normally, because an invoice covers a consignment. It is
 * allowed against the order alone for the case that does happen — a single
 * invoice covering several dispatches — and then the dispatch link is left
 * empty rather than being pointed at whichever one seemed closest.
 */
export function raiseInvoice({ dispatchId = null, orderId = null, invoiceNumber, invoiceDate, amount }, actor) {
  const number = String(invoiceNumber || '').trim();
  if (!number) {
    throw new Error('The invoice number is required — it is the number on the invoice raised in Tally, not one this app issues.');
  }

  let dispatch = null;
  if (dispatchId) {
    dispatch = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(dispatchId);
    if (!dispatch) throw new Error('No such dispatch');
    if (!['dispatched', 'delivered'].includes(dispatch.status)) {
      // Invoicing a pick list would put a tax document against goods that are
      // still on the rack, and the quantities on it can still change.
      throw new Error(`${dispatch.dispatch_number} has not gone out yet. Invoice it once it has left.`);
    }
    orderId = dispatch.order_id;
  }
  if (!orderId) throw new Error('An invoice needs a dispatch or an order.');

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('No such order');

  const existing = db.prepare('SELECT id FROM invoices WHERE invoice_number = ? AND order_id = ?').get(number, orderId);
  if (existing) throw new Error(`${number} is already recorded against ${order.order_number}.`);
  if (dispatchId && db.prepare('SELECT id FROM invoices WHERE dispatch_id = ?').get(dispatchId)) {
    throw new Error(`${dispatch.dispatch_number} has already been invoiced.`);
  }

  const value = dispatchId ? valueOfDispatch(dispatchId).total : order.total;
  return db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO invoices (order_id, dispatch_id, invoice_number, invoice_date, amount)
      VALUES (?, ?, ?, ?, ?)`)
      .run(orderId, dispatchId, number, invoiceDate || todayISO(), amount === undefined || amount === '' ? value : Number(amount) || 0);
    const id = info.lastInsertRowid;
    logEvent(id, orderId, 'invoiced', actor, `${number} raised${dispatch ? ` for ${dispatch.dispatch_number}` : ''}`);
    // Tried at once, because the usual case is that the bill is already in
    // Tally and the last sync brought it in. Failing to find it is normal too:
    // an invoice raised five minutes ago has not been synced yet.
    matchInvoice(id, { actor, silent: true });
    queue('invoices', id);
    return getInvoice(id);
  })();
}

export function updateInvoice(id, { invoiceNumber, invoiceDate, amount }, actor) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return null;
  const number = invoiceNumber === undefined ? inv.invoice_number : String(invoiceNumber).trim();
  if (!number) throw new Error('The invoice number cannot be blank.');

  db.prepare(`
    UPDATE invoices SET invoice_number = ?, invoice_date = COALESCE(?, invoice_date), amount = COALESCE(?, amount)
    WHERE id = ?`)
    .run(number, invoiceDate || null, amount === undefined || amount === '' ? null : Number(amount) || 0, id);

  // The number changed, so whatever it was linked to is no longer the answer.
  // Clearing the link and looking again is the only honest thing to do.
  if (number !== inv.invoice_number) {
    db.prepare('UPDATE invoices SET tally_bill_ref = NULL, matched_at = NULL WHERE id = ?').run(id);
    matchInvoice(id, { actor, silent: true });
  }
  queue('invoices', id);
  return getInvoice(id);
}

export function deleteInvoice(id, actor) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return null;
  db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  logEvent(id, inv.order_id, 'invoice-removed', actor, `${inv.invoice_number} removed`);
  queue('invoices', id, 'delete');
  return { removed: true, invoiceNumber: inv.invoice_number };
}

// --- Matching to Tally ------------------------------------------------------

/**
 * Find the Tally bill this invoice is, and link it.
 *
 * The party has to agree. Matching on the reference alone would link an
 * invoice to a same-numbered bill belonging to somebody else — which does not
 * throw, does not look wrong on any screen, and produces a payment chase
 * addressed to the wrong company.
 *
 * Where the reference matches but the party does not, that is not silently
 * dropped either: it comes back as a candidate for a person to look at, since
 * it usually means the order is against a slightly different ledger name.
 */
export function matchInvoice(id, { actor = null, silent = false } = {}) {
  const inv = db.prepare(`
    SELECT i.*, o.customer_name FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.id = ?`).get(id);
  if (!inv) return null;

  const wanted = normalise(inv.invoice_number);
  const bill = db
    .prepare(`
      SELECT * FROM tally_bills
      WHERE party_name = ? AND UPPER(REPLACE(bill_ref, ' ', '')) = ?`)
    .get(inv.customer_name, wanted);

  if (!bill) return { matched: false, candidates: candidatesFor(inv) };

  db.prepare(`UPDATE invoices SET tally_bill_ref = ?, matched_at = ? WHERE id = ?`)
    .run(bill.bill_ref, new Date().toISOString(), id);
  if (!silent) logEvent(id, inv.order_id, 'matched', actor, `${inv.invoice_number} matched to Tally bill ${bill.bill_ref}`);
  queue('invoices', id);
  return { matched: true, billRef: bill.bill_ref };
}

/** Same reference, different party. Shown to a person; never linked by a rule. */
function candidatesFor(inv) {
  const wanted = normalise(inv.invoice_number);
  return db
    .prepare(`SELECT * FROM tally_bills WHERE UPPER(REPLACE(bill_ref, ' ', '')) = ? LIMIT 5`)
    .all(wanted);
}

/**
 * Link an invoice to a bill by hand.
 *
 * The escape hatch for the case the rule cannot decide: the order is against
 * "Sanghvi Industries" and the bill is against "Sanghvi Industries Pvt Ltd".
 * A person can see that those are the same company; nothing here can, and a
 * rule confident enough to say so would also be confident about pairs that are
 * not the same company at all.
 */
export function linkInvoice(id, billRef, actor) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return null;
  if (!billRef) {
    db.prepare('UPDATE invoices SET tally_bill_ref = NULL, matched_at = NULL WHERE id = ?').run(id);
    logEvent(id, inv.order_id, 'unlinked', actor, `${inv.invoice_number} unlinked from Tally`);
    queue('invoices', id);
    return getInvoice(id);
  }
  const bill = db.prepare('SELECT * FROM tally_bills WHERE bill_ref = ? LIMIT 1').get(billRef);
  if (!bill) throw new Error(`No bill ${billRef} in the Tally mirror. Sync, then try again.`);
  db.prepare(`UPDATE invoices SET tally_bill_ref = ?, matched_at = ? WHERE id = ?`)
    .run(bill.bill_ref, new Date().toISOString(), id);
  logEvent(id, inv.order_id, 'matched', actor, `${inv.invoice_number} linked by hand to ${bill.bill_ref} (${bill.party_name})`);
  queue('invoices', id);
  return getInvoice(id);
}

/**
 * Re-match everything unmatched. Run after every sync.
 *
 * Only the unmatched, because a bill that has been matched and has since
 * disappeared from the receivables collection has been PAID IN FULL — Tally
 * stops returning it — and re-running the match over it would helpfully undo
 * the link and report the invoice as missing.
 */
export function matchAll() {
  const rows = db.prepare('SELECT id FROM invoices WHERE tally_bill_ref IS NULL').all();
  let matched = 0;
  for (const r of rows) {
    if (matchInvoice(r.id, { silent: true })?.matched) matched += 1;
  }
  return { considered: rows.length, matched };
}

// --- The payment clock, read from Tally -------------------------------------

/**
 * Where an invoice stands, worked out fresh every time from Tally's bill.
 *
 * The `paid` case is the subtle one. A bill settled in full stops appearing in
 * Tally's receivables at all, so "we matched this once and the bill is gone"
 * means paid — whereas "we never matched it" means the invoice cannot be found.
 * The two look identical if you only check whether a bill is there now, which
 * is why `matched_at` is recorded and not merely the reference.
 */
/**
 * The invoice we recorded and the bill it is linked to should be for the same
 * money. When they are not, by more than rounding, something is wrong — and it
 * is almost always the link rather than the arithmetic.
 *
 * This is the check that catches the mistake the party rule cannot: a bill
 * reference typed one digit out that happens to be a real bill for the right
 * customer. The numbers match, the party matches, nothing throws, and the
 * payment position shown is somebody else's consignment. The amounts are what
 * give it away.
 *
 * Reported, never acted on. A part-invoiced consignment or a bill covering two
 * dispatches is a legitimate reason for the two to differ, so this raises the
 * question and leaves the answer to a person.
 */
function amountMismatch(invoiceAmount, billAmount) {
  const ours = Number(invoiceAmount) || 0;
  const theirs = Number(billAmount) || 0;
  if (!ours || !theirs) return null;
  const difference = Math.round((theirs - ours) * 100) / 100;
  // Half a percent, with a one-rupee floor: GST rounding on a small invoice
  // legitimately differs by a rupee or two, and flagging that would train
  // people to ignore the flag.
  const tolerance = Math.max(1, theirs * 0.005);
  if (Math.abs(difference) <= tolerance) return null;
  return { recorded: ours, billed: theirs, difference };
}

export function paymentPosition(inv) {
  if (!inv.tally_bill_ref) {
    return { status: 'unmatched', label: 'Not found in Tally', outstanding: null, paid: null, daysOverdue: 0 };
  }
  const bill = db
    .prepare('SELECT * FROM tally_bills WHERE bill_ref = ? ORDER BY party_name LIMIT 1')
    .get(inv.tally_bill_ref);

  if (!bill) {
    return {
      status: 'paid', label: 'Paid', outstanding: 0, paid: inv.amount, daysOverdue: 0,
      note: 'Settled — Tally no longer carries it as receivable.',
    };
  }

  const outstanding = bill.amount;
  const paid = Math.max(0, (bill.opening_amount || 0) - outstanding);
  const mismatch = amountMismatch(inv.amount, bill.opening_amount);
  const dueDate = bill.due_date || null;
  const daysOverdue = dueDate
    ? Math.max(0, daysSince(dueDate))
    : Math.max(0, daysSince(bill.bill_date) - (bill.credit_period_days || config.rules.defaultCreditPeriodDays));

  if (outstanding <= 0.01) {
    return { status: 'paid', label: 'Paid', outstanding: 0, paid: bill.opening_amount, daysOverdue: 0, bill, mismatch };
  }
  const partPaid = paid > 0.01;
  if (daysOverdue > 0) {
    return {
      status: 'overdue',
      label: partPaid ? `Part paid, ${daysOverdue} days overdue` : `${daysOverdue} days overdue`,
      outstanding, paid, daysOverdue, dueDate, partPaid, bill, mismatch,
    };
  }
  return {
    status: 'outstanding',
    label: partPaid ? 'Part paid, within terms' : 'Within terms',
    outstanding, paid, daysOverdue: 0, dueDate, partPaid, bill, mismatch,
  };
}

// --- Reading ----------------------------------------------------------------

export function getInvoice(id) {
  const inv = db
    .prepare(`
      SELECT i.*, o.order_number, o.customer_name, o.customer_po_number, o.payment_terms_days,
             d.dispatch_number, d.lr_number, d.transporter, d.dispatched_at
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      LEFT JOIN dispatches d ON d.id = i.dispatch_id
      WHERE i.id = ?`)
    .get(id);
  if (!inv) return null;
  const position = paymentPosition(inv);
  return {
    ...inv,
    position,
    // Only worth computing when there is a problem to solve.
    candidates: position.status === 'unmatched' ? candidatesFor(inv) : [],
    events: db.prepare(`SELECT * FROM pipeline_events WHERE entity_type = 'invoice' AND entity_id = ? ORDER BY id`).all(id),
  };
}

export function listInvoices({ status = '', search = '', limit = 200 } = {}) {
  const where = [];
  const params = { limit };
  if (search) {
    where.push('(i.invoice_number LIKE @q OR o.order_number LIKE @q OR o.customer_name LIKE @q OR d.dispatch_number LIKE @q)');
    params.q = `%${search}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`
      SELECT i.*, o.order_number, o.customer_name, d.dispatch_number
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      LEFT JOIN dispatches d ON d.id = i.dispatch_id
      ${clause} ORDER BY i.id DESC LIMIT @limit`)
    .all(params)
    .map((r) => ({ ...r, position: paymentPosition(r) }));

  // Filtered after the fact, because status is not a column — it is Tally's
  // current answer, and there is nothing in this database to filter on.
  return status ? rows.filter((r) => r.position.status === status) : rows;
}

/**
 * Gone, and not invoiced.
 *
 * The queue that costs actual money. A consignment that left three weeks ago
 * with no invoice against it is revenue nobody is chasing, because no clock
 * has started — there is no bill for it to be overdue on.
 */
export function awaitingInvoice({ limit = 100 } = {}) {
  return db
    .prepare(`
      SELECT d.id, d.dispatch_number, d.status, d.dispatched_at, d.lr_number, d.transporter,
             o.id AS order_id, o.order_number, o.customer_name, o.customer_po_number
      FROM dispatches d
      JOIN orders o ON o.id = d.order_id
      WHERE d.status IN ('dispatched', 'delivered')
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.dispatch_id = d.id)
      ORDER BY d.dispatched_at, d.id
      LIMIT ?`)
    .all(limit)
    .map((d) => ({ ...d, value: valueOfDispatch(d.id), daysSinceDispatch: daysSince(d.dispatched_at) }));
}

export function invoiceSummary() {
  const all = listInvoices({ limit: 5000 });
  const sum = (rows, f) => rows.reduce((n, r) => n + (f(r) || 0), 0);
  const overdue = all.filter((r) => r.position.status === 'overdue');
  const outstanding = all.filter((r) => ['overdue', 'outstanding'].includes(r.position.status));
  const waiting = awaitingInvoice({ limit: 1000 });

  return {
    invoices: all.length,
    awaitingInvoice: waiting.length,
    awaitingValue: sum(waiting, (d) => d.value.total),
    // The oldest thing sitting uninvoiced, which is the number that says how
    // bad the backlog actually is. Ten of them one day old is a busy week;
    // one of them forty days old is money nobody is looking for.
    oldestUninvoicedDays: waiting.reduce((m, d) => Math.max(m, d.daysSinceDispatch), 0),
    unmatched: all.filter((r) => r.position.status === 'unmatched').length,
    outstandingCount: outstanding.length,
    outstandingValue: sum(outstanding, (r) => r.position.outstanding),
    overdueCount: overdue.length,
    overdueValue: sum(overdue, (r) => r.position.outstanding),
    paidCount: all.filter((r) => r.position.status === 'paid').length,
  };
}

/** Invoices raised against one order, for the order screen. */
export function forOrder(orderId) {
  return db
    .prepare(`
      SELECT i.*, d.dispatch_number FROM invoices i
      LEFT JOIN dispatches d ON d.id = i.dispatch_id
      WHERE i.order_id = ? ORDER BY i.id`)
    .all(orderId)
    .map((r) => ({ ...r, position: paymentPosition(r) }));
}
