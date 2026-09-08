/**
 * Picking, dispatch and the LR — what actually left the godown.
 *
 * The stage the plan describes as the one that stops a short shipment being
 * discovered days later, by a phone call, from the customer.
 *
 * THE ORDER SAYS WHAT WAS ASKED FOR. THIS SAYS WHAT WENT.
 * They are different things and the difference is the whole point. An order for
 * 200 metres against which 150 went out is not an error to be corrected — it is
 * a fact to be recorded, at the moment it happens, by the person who packed it.
 * Everything else follows: the order's status derives from these rows, the
 * balance stays visible as pending, and nobody has to remember anything.
 *
 * FOUR STATES, AND WHAT EACH ONE MEANS
 *
 *   picking     a pick list. Nothing has moved. Quantities are provisional.
 *   packed      boxed and staged. Still here. Quantities are settled.
 *   dispatched  it has left. Quantities are now a record, not a plan.
 *   delivered   the customer has it.
 *
 * Only `dispatched` and `delivered` count towards an order being fulfilled,
 * which is why a pick list can be abandoned without consequence and a dispatch
 * cannot be un-sent.
 */
import { db } from '../db/index.js';
import { queueDispatch, queue } from '../sheets/store.js';
import { mintNumber } from '../lib/numbering.js';
import { todayISO } from '../lib/dates.js';
import { refreshStatus, getOrder } from '../orders/service.js';

/** Gone for good: the two states that mean stock has actually left. */
export const SHIPPED = ['dispatched', 'delivered'];

/** Still ours: a pick list or a packed lot, holding stock it has not taken yet. */
export const OPEN = ['picking', 'packed'];

const ORDER = ['picking', 'packed', 'dispatched', 'delivered'];

export function nextDispatchNumber() {
  return mintNumber({ prefix: 'BE/DN', table: 'dispatches', column: 'dispatch_number', what: 'dispatch number' });
}

function logEvent(dispatchId, orderId, from, to, actor, note) {
  const info = db.prepare(
    `INSERT INTO pipeline_events (entity_type, entity_id, order_id, from_stage, to_stage, note, actor_id, actor_name)
     VALUES ('dispatch', ?, ?, ?, ?, ?, ?, ?)`
  ).run(dispatchId, orderId, from || null, to, note || null, actor?.id || null, actor?.name || null);
  queue('pipeline_events', info.lastInsertRowid);
}

// --- What is left to send ---------------------------------------------------

/**
 * Each order line with three numbers against it, and they are three different
 * questions.
 *
 *   gone       already dispatched or delivered. Fulfilment.
 *   allocated  sitting in somebody's open pick list, here or on another
 *              trolley. Not gone, but already spoken for.
 *   pending    what is genuinely still available to put on a new dispatch.
 *
 * The middle one is the one that is easy to leave out and expensive to leave
 * out. Without it, two people picking the same order at the same time are each
 * shown the full outstanding quantity, both pick it, and the second lorry
 * leaves with stock that is not there. `excludeDispatchId` is how a pick list
 * asks the question about itself without counting its own claim twice.
 */
export function pendingLines(orderId, { excludeDispatchId = null } = {}) {
  return db
    .prepare(`
      SELECT ol.*,
             COALESCE(gone.qty, 0) AS qty_gone,
             COALESCE(held.qty, 0) AS qty_allocated,
             ol.qty_ordered - COALESCE(gone.qty, 0) - COALESCE(held.qty, 0) AS qty_pending
      FROM order_lines ol
      LEFT JOIN (
        SELECT dl.order_line_id, SUM(dl.qty_dispatched) AS qty
        FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id
        WHERE d.status IN ('dispatched', 'delivered')
        GROUP BY dl.order_line_id
      ) gone ON gone.order_line_id = ol.id
      LEFT JOIN (
        SELECT dl.order_line_id, SUM(dl.qty_dispatched) AS qty
        FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id
        WHERE d.status IN ('picking', 'packed') AND d.id IS NOT ?
        GROUP BY dl.order_line_id
      ) held ON held.order_line_id = ol.id
      WHERE ol.order_id = ?
      ORDER BY ol.line_no`)
    .all(excludeDispatchId, orderId);
}

/** Orders with something still to send, newest first. The queue to pick from. */
export function readyToPick({ limit = 100 } = {}) {
  return db
    .prepare(`
      SELECT o.id, o.order_number, o.customer_name, o.customer_po_number, o.received_at,
             o.total, o.status, o.credit_status,
             COUNT(ol.id) AS lines,
             SUM(CASE WHEN ol.qty_ordered - COALESCE(gone.qty,0) - COALESCE(held.qty,0) > 0 THEN 1 ELSE 0 END) AS lines_pending
      FROM orders o
      JOIN order_lines ol ON ol.order_id = o.id
      LEFT JOIN (
        SELECT dl.order_line_id, SUM(dl.qty_dispatched) AS qty
        FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id
        WHERE d.status IN ('dispatched', 'delivered') GROUP BY dl.order_line_id
      ) gone ON gone.order_line_id = ol.id
      LEFT JOIN (
        SELECT dl.order_line_id, SUM(dl.qty_dispatched) AS qty
        FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id
        WHERE d.status IN ('picking', 'packed') GROUP BY dl.order_line_id
      ) held ON held.order_line_id = ol.id
      WHERE o.status NOT IN ('cancelled', 'closed')
      GROUP BY o.id
      HAVING lines_pending > 0
      ORDER BY o.received_at, o.id
      LIMIT ?`)
    .all(limit);
}

// --- Creating a pick list ---------------------------------------------------

/**
 * Start a pick list for an order, prefilled with everything still outstanding.
 *
 * Prefilled rather than empty because the common case by a distance is "send
 * all of it", and the exceptional case — a short shipment — is a matter of
 * changing a number that is already in front of you. An empty list would make
 * the ordinary path the laborious one.
 */
export function createDispatch(orderId, actor) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('No such order');
  if (order.status === 'cancelled') throw new Error(`${order.order_number} is cancelled.`);

  const pending = pendingLines(orderId).filter((l) => l.qty_pending > 0);
  if (!pending.length) {
    const anyLines = db.prepare('SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ?').get(orderId).n;
    throw new Error(anyLines
      ? `Nothing is outstanding on ${order.order_number} — everything is either gone or already on a pick list.`
      : `${order.order_number} has no items entered yet, so there is nothing to pick.`);
  }

  const dispatchNumber = nextDispatchNumber();
  return db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO dispatches (order_id, dispatch_number, status, created_by) VALUES (?, ?, 'picking', ?)`
    ).run(orderId, dispatchNumber, actor?.id || null);
    const id = info.lastInsertRowid;

    const insert = db.prepare(`
      INSERT INTO dispatch_lines (dispatch_id, order_line_id, item_name, qty_dispatched, units)
      VALUES (?, ?, ?, ?, ?)`);
    for (const line of pending) {
      insert.run(id, line.id, line.item_name, line.qty_pending, line.units);
    }

    logEvent(id, orderId, null, 'picking', actor, `${dispatchNumber} pick list raised for ${order.order_number}`);
    queueDispatch(id);
    return getDispatch(id);
  })();
}

/**
 * Throw a pick list away.
 *
 * Only while nothing has moved. Someone starting a pick list on the wrong order
 * at eight in the morning should be able to undo it without leaving a scar on
 * the record — but a dispatch that has gone is a fact, and facts are corrected
 * by recording the next one, not by deleting the last.
 */
export function abandon(id, actor) {
  const d = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(id);
  if (!d) return null;
  if (d.status !== 'picking') {
    throw new Error(`${d.dispatch_number} is ${d.status} and cannot be discarded. Record what actually happened instead.`);
  }
  return db.transaction(() => {
    db.prepare('DELETE FROM dispatches WHERE id = ?').run(id);   // lines cascade
    logEvent(id, d.order_id, 'picking', 'discarded', actor, `${d.dispatch_number} pick list discarded`);
    queue('dispatches', id, 'delete');
    queue('dispatch_lines', id, 'delete');
    refreshStatus(d.order_id);
    return { discarded: true, dispatchNumber: d.dispatch_number, orderId: d.order_id };
  })();
}

// --- Editing ----------------------------------------------------------------

/**
 * What is being picked, and the lorry it is going on.
 *
 * Quantities are only editable while the lot is still here. Once it has left,
 * the numbers are a record of what left, and an interface that lets someone
 * quietly change them a week later is an interface that cannot be used to
 * settle a dispute about a short delivery.
 *
 * The LR details are the exception, and deliberately so — see `setStatus`.
 */
export function updateDispatch(id, input, actor) {
  const d = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(id);
  if (!d) return null;

  const editable = OPEN.includes(d.status);
  if (input.lines && !editable) {
    throw new Error(`${d.dispatch_number} has already gone. What went out cannot be edited — record a further dispatch, or a credit note.`);
  }

  return db.transaction(() => {
    if (input.lines) writeLines(d, input.lines);

    db.prepare(`
      UPDATE dispatches SET
        lr_number = COALESCE(?, lr_number),
        transporter = COALESCE(?, transporter),
        lr_date = COALESCE(?, lr_date),
        freight_amount = COALESCE(?, freight_amount),
        notes = COALESCE(?, notes),
        updated_at = datetime('now')
      WHERE id = ?`)
      .run(
        blankToNull(input.lrNumber), blankToNull(input.transporter), blankToNull(input.lrDate),
        input.freightAmount === undefined || input.freightAmount === '' ? null : Number(input.freightAmount) || 0,
        input.notes === undefined ? null : String(input.notes),
        id
      );

    // Recorded as an event, because "when did the LR number appear" is exactly
    // the question asked three weeks later when a delivery is disputed.
    if (input.lrNumber && input.lrNumber !== d.lr_number) {
      logEvent(id, d.order_id, d.status, d.status, actor, `LR ${input.lrNumber}${input.transporter ? ` with ${input.transporter}` : ''}`);
    }

    queueDispatch(id);
    return getDispatch(id);
  })();
}

function writeLines(dispatch, lines) {
  const allowed = new Map(
    pendingLines(dispatch.order_id, { excludeDispatchId: dispatch.id }).map((l) => [l.id, l])
  );

  const rows = [];
  for (const line of lines) {
    const orderLineId = Number(line.orderLineId);
    const reference = allowed.get(orderLineId);
    if (!reference) throw new Error('A line was sent that does not belong to this order.');

    const qty = Number(line.qty) || 0;
    if (qty < 0) throw new Error(`A negative quantity was sent for ${reference.item_name}.`);
    if (qty === 0) continue;                        // picked nothing: no row

    // Over-picking is refused rather than warned about. A dispatch line for
    // more than was ordered makes the order permanently unreconcilable, and
    // the legitimate version of this — sending extra as a goodwill top-up —
    // is a change to the order, which is where it should be recorded.
    if (qty > reference.qty_pending + 1e-9) {
      throw new Error(
        `${reference.item_name}: ${qty} ${reference.units || ''} is more than the ${reference.qty_pending} still outstanding` +
        (reference.qty_allocated ? ` (${reference.qty_allocated} is on another open pick list).` : '.')
      );
    }
    rows.push({
      dispatch_id: dispatch.id,
      order_line_id: orderLineId,
      // What actually left, by name. A substitution keeps the order line it is
      // answering — otherwise the order can never be shown as fulfilled — but
      // says plainly that something else went, which is what the customer will
      // find in the box.
      item_name: reference.item_name,
      qty_dispatched: qty,
      units: line.units || reference.units || null,
      substituted_with: blankToNull(line.substitutedWith),
      notes: blankToNull(line.notes),
    });
  }
  if (!rows.length) throw new Error('A dispatch needs at least one line with a quantity on it.');

  db.prepare('DELETE FROM dispatch_lines WHERE dispatch_id = ?').run(dispatch.id);
  const insert = db.prepare(`
    INSERT INTO dispatch_lines (dispatch_id, order_line_id, item_name, qty_dispatched, units, substituted_with, notes)
    VALUES (@dispatch_id, @order_line_id, @item_name, @qty_dispatched, @units, @substituted_with, @notes)`);
  for (const r of rows) insert.run(r);
}

const blankToNull = (v) => (v === undefined ? null : String(v).trim() === '' ? null : String(v).trim());

// --- Moving it along --------------------------------------------------------

/**
 * Advance a dispatch, or send it back to picking.
 *
 * THE LR IS NOT REQUIRED TO MARK SOMETHING DISPATCHED, AND THAT IS NOT AN
 * OVERSIGHT. The lorry receipt frequently arrives after the vehicle has gone —
 * the transporter hands it over later, or mails it that evening. Requiring it
 * at the moment of dispatch gives two bad outcomes and no good one: either the
 * dispatch is recorded late, so the record is wrong for a day, or somebody
 * types a placeholder, so the record is wrong for ever. Instead it goes out
 * without one, and "gone, no LR yet" is a queue on the screen that clears
 * itself as the receipts come in.
 */
export function setStatus(id, status, actor, { note } = {}) {
  if (!ORDER.includes(status)) throw new Error(`Unknown dispatch status '${status}'`);
  const d = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(id);
  if (!d) return null;
  if (d.status === status) return getDispatch(id);

  const from = ORDER.indexOf(d.status);
  const to = ORDER.indexOf(status);

  // Backwards is allowed exactly once: packed to picking, because unpacking a
  // lot to change it is an ordinary Tuesday. Everything else that has moved
  // forward has left the building.
  const goingBack = to < from;
  if (goingBack && !(d.status === 'packed' && status === 'picking')) {
    throw new Error(`${d.dispatch_number} is already ${d.status}. That cannot be undone — record what happened next instead.`);
  }
  if (to > from + 1) {
    throw new Error(`${d.dispatch_number} is ${d.status}; it has to be marked ${ORDER[from + 1]} first.`);
  }

  const lines = db.prepare('SELECT * FROM dispatch_lines WHERE dispatch_id = ?').all(id);
  if (status === 'packed' && !lines.some((l) => l.qty_dispatched > 0)) {
    throw new Error(`${d.dispatch_number} has nothing on it yet.`);
  }

  return db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE dispatches SET status = ?,
        packed_at     = CASE WHEN ? = 'packed'     THEN COALESCE(packed_at, ?)     ELSE packed_at END,
        dispatched_at = CASE WHEN ? = 'dispatched' THEN COALESCE(dispatched_at, ?) ELSE dispatched_at END,
        delivered_at  = CASE WHEN ? = 'delivered'  THEN COALESCE(delivered_at, ?)  ELSE delivered_at END,
        updated_at = datetime('now')
      WHERE id = ?`)
      .run(status, status, now, status, now, status, now, id);

    const shipped = lines.reduce((n, l) => n + l.qty_dispatched, 0);
    logEvent(id, d.order_id, d.status, status, actor,
      note || `${d.dispatch_number} ${status}${status === 'dispatched' ? ` — ${lines.length} line(s), ${shipped} unit(s)` : ''}`);

    queueDispatch(id);
    // The order's status is derived from its dispatches, so it changes the
    // moment this one crosses into 'dispatched'. Nobody marks an order
    // part-shipped; it becomes part-shipped.
    refreshStatus(d.order_id);
    return getDispatch(id);
  })();
}

/** Proof of delivery in hand. Recorded separately: it arrives days later. */
export function setPod(id, received, actor) {
  const d = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(id);
  if (!d) return null;
  db.prepare(`UPDATE dispatches SET pod_received = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(received ? 1 : 0, id);
  logEvent(id, d.order_id, d.status, d.status, actor, received ? 'POD received' : 'POD marked not received');
  queueDispatch(id);
  return getDispatch(id);
}

// --- Reading ----------------------------------------------------------------

export function getLines(dispatchId) {
  return db
    .prepare(`
      SELECT dl.*, ol.line_no, ol.qty_ordered, ol.item_code, ol.brand, ol.units AS order_units,
             ol.rate, ol.gst_rate
      FROM dispatch_lines dl
      JOIN order_lines ol ON ol.id = dl.order_line_id
      WHERE dl.dispatch_id = ? ORDER BY ol.line_no`)
    .all(dispatchId);
}

export function getDispatch(id) {
  const d = db.prepare('SELECT * FROM dispatches WHERE id = ?').get(id);
  if (!d) return null;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(d.order_id);
  const lines = getLines(id);
  const shipped = lines.reduce((n, l) => n + l.qty_dispatched, 0);
  const value = lines.reduce((n, l) => n + l.qty_dispatched * (l.rate || 0), 0);

  return {
    ...d,
    order: order
      ? {
          id: order.id, order_number: order.order_number, customer_name: order.customer_name,
          customer_po_number: order.customer_po_number, status: order.status,
          document_url: order.document_url, payment_terms_days: order.payment_terms_days,
        }
      : null,
    lines,
    // Every line of the order, whether or not it is on this dispatch, with
    // what is left. A pick list that hides the lines it is not taking cannot
    // be used to decide whether to take them.
    orderLines: pendingLines(d.order_id, { excludeDispatchId: id }),
    events: db.prepare(`SELECT * FROM pipeline_events WHERE entity_type = 'dispatch' AND entity_id = ? ORDER BY id`).all(id),
    totals: { lines: lines.length, units: shipped, value },
    /** Gone, with no lorry receipt against it. The queue that has to clear. */
    awaitingLr: SHIPPED.includes(d.status) && !d.lr_number,
  };
}

export function listDispatches({ status = '', search = '', orderId = null, limit = 100 } = {}) {
  const where = [];
  const params = { limit };
  if (status === 'awaiting_lr') {
    where.push(`d.status IN ('dispatched','delivered') AND (d.lr_number IS NULL OR d.lr_number = '')`);
  } else if (status === 'open') {
    where.push(`d.status IN ('picking','packed')`);
  } else if (status === 'awaiting_pod') {
    where.push(`d.status = 'delivered' AND d.pod_received = 0`);
  } else if (status) {
    where.push('d.status = @status');
    params.status = status;
  }
  if (orderId) { where.push('d.order_id = @orderId'); params.orderId = orderId; }
  if (search) {
    where.push('(d.dispatch_number LIKE @q OR d.lr_number LIKE @q OR d.transporter LIKE @q OR o.order_number LIKE @q OR o.customer_name LIKE @q)');
    params.q = `%${search}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`
      SELECT d.*, o.order_number, o.customer_name, o.customer_po_number,
             (SELECT COUNT(*) FROM dispatch_lines dl WHERE dl.dispatch_id = d.id) AS line_count,
             (SELECT COALESCE(SUM(dl.qty_dispatched), 0) FROM dispatch_lines dl WHERE dl.dispatch_id = d.id) AS units
      FROM dispatches d JOIN orders o ON o.id = d.order_id
      ${clause} ORDER BY d.id DESC LIMIT @limit`)
    .all(params);
}

export function dispatchSummary() {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const pick = readyToPick({ limit: 1000 });
  return {
    readyToPick: pick.length,
    picking: one(`SELECT COUNT(*) AS n FROM dispatches WHERE status = 'picking'`).n,
    packed: one(`SELECT COUNT(*) AS n FROM dispatches WHERE status = 'packed'`).n,
    inTransit: one(`SELECT COUNT(*) AS n FROM dispatches WHERE status = 'dispatched'`).n,
    // Two queues that only exist because paperwork lags the lorry. Both are
    // meant to sit at zero and be visibly annoying when they do not.
    awaitingLr: one(`SELECT COUNT(*) AS n FROM dispatches
                     WHERE status IN ('dispatched','delivered') AND (lr_number IS NULL OR lr_number = '')`).n,
    awaitingPod: one(`SELECT COUNT(*) AS n FROM dispatches WHERE status = 'delivered' AND pod_received = 0`).n,
    shippedThisMonth: one(`SELECT COUNT(*) AS n FROM dispatches
                           WHERE status IN ('dispatched','delivered')
                             AND dispatched_at >= date('now','start of month')`).n,
  };
}

/** Everything sent against one order, for the order screen. */
export function forOrder(orderId) {
  return listDispatches({ orderId, limit: 100 });
}

export { getOrder, todayISO };
