/**
 * Orders — the "Order Received" stage.
 *
 * A customer's purchase order, recorded once, that every department afterwards
 * reads from. This is the point the plan describes as the actual fix: from here
 * on, what was ordered stops being a WhatsApp message and becomes a record.
 *
 * Two decisions are baked in:
 *
 *   Credit is REPORTED, NOT ENFORCED. The customer's position is evaluated and
 *   snapshotted onto the order as it is received, and nothing is blocked. The
 *   snapshot is deliberate — knowing what their exposure looked like when the
 *   order was taken is what makes it reviewable later, and a live figure would
 *   quietly rewrite history every time a bill was paid.
 *
 *   The order holds what was ORDERED. What actually ships lives on dispatches,
 *   which is why status is derived rather than set: one order can ship in
 *   several lots, and nobody should have to remember to mark it part-shipped.
 */
import { db } from '../db/index.js';
import { todayISO } from '../lib/dates.js';
import { customerCredit } from '../customers/service.js';
import { priceLine, totalsFor, getQuotation } from '../quotations/service.js';

function fyTag(date = new Date()) {
  const y = date.getMonth() + 1 >= 4 ? date.getFullYear() : date.getFullYear() - 1;
  return `${String(y).slice(2)}${String(y + 1).slice(2)}`;
}

export function nextOrderNumber() {
  const prefix = `BE/SO/${fyTag()}/`;
  const rows = db.prepare('SELECT order_number FROM orders WHERE order_number LIKE ?').all(`${prefix}%`);
  const highest = rows.reduce((max, r) => {
    const n = Number(String(r.order_number).slice(prefix.length));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(4, '0')}`;
}

function logEvent(entityId, orderId, to, actor, note) {
  db.prepare(
    `INSERT INTO pipeline_events (entity_type, entity_id, order_id, from_stage, to_stage, note, actor_id, actor_name)
     VALUES ('order', ?, ?, NULL, ?, ?, ?, ?)`
  ).run(entityId, orderId, to, note || null, actor?.id || null, actor?.name || null);
}

function writeLines(orderId, lines) {
  db.prepare('DELETE FROM order_lines WHERE order_id = ?').run(orderId);
  const insert = db.prepare(`
    INSERT INTO order_lines (order_id, line_no, item_name, item_guid, item_code,
      qty_ordered, units, rate, gst_rate, amount, brand, hsn, notes)
    VALUES (@order_id, @line_no, @item_name, @item_guid, @item_code,
      @qty_ordered, @units, @rate, @gst_rate, @amount, @brand, @hsn, @notes)`);
  lines.forEach((l, i) => {
    const p = priceLine({ qty: l.qty, rate: l.rate, discountPct: 0, gstRate: l.gstRate });
    insert.run({
      order_id: orderId,
      line_no: i + 1,
      item_name: l.itemName || '',
      item_guid: l.itemGuid || null,
      item_code: l.itemCode || null,
      qty_ordered: Number(l.qty) || 0,
      units: l.units || 'Nos',
      rate: Number(l.rate) || 0,
      gst_rate: Number(l.gstRate) || 0,
      amount: p.taxable,
      brand: l.brand || null,
      hsn: l.hsn || null,
      notes: l.notes || null,
    });
  });
}

const asPricing = (lines) =>
  lines.map((l) => ({ qty: l.qty, rate: l.rate, discountPct: 0, gstRate: l.gstRate }));

/**
 * Where an order stands, worked out from its dispatches rather than stored.
 *
 * Cancelled is the one status a person sets; everything else follows from how
 * much of each line has actually left. Deriving it means a part-shipment can
 * never be forgotten about, which is precisely the failure this stage exists
 * to remove.
 */
export function deriveStatus(orderId) {
  const row = db
    .prepare(`SELECT cancelled_reason, status FROM orders WHERE id = ?`)
    .get(orderId);
  if (!row) return null;
  if (row.status === 'cancelled') return 'cancelled';

  const totals = db
    .prepare(`
      SELECT COALESCE(SUM(ol.qty_ordered), 0) AS ordered,
             COALESCE(SUM(sent.qty), 0) AS dispatched
      FROM order_lines ol
      LEFT JOIN (
        SELECT dl.order_line_id, SUM(dl.qty_dispatched) AS qty
        FROM dispatch_lines dl
        JOIN dispatches d ON d.id = dl.dispatch_id
        WHERE d.status IN ('dispatched', 'delivered')
        GROUP BY dl.order_line_id
      ) sent ON sent.order_line_id = ol.id
      WHERE ol.order_id = ?`)
    .get(orderId);

  if (!totals.ordered) return 'open';
  if (totals.dispatched <= 0) return 'open';
  return totals.dispatched >= totals.ordered ? 'dispatched' : 'part_dispatched';
}

function refreshStatus(orderId) {
  const status = deriveStatus(orderId);
  if (status) db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, orderId);
  return status;
}

export function createOrder(input, actor) {
  const {
    customerName, customerGuid, customerPoNumber, poDate, quotationId,
    lines = [], paymentTermsDays, notes, receivedAt,
  } = input;
  if (!customerName) throw new Error('A customer is required');
  if (!lines.length) throw new Error('An order needs at least one line');

  const t = totalsFor(asPricing(lines));
  const credit = customerCredit(customerName, t.total);
  const orderNumber = nextOrderNumber();

  return db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO orders (order_number, customer_po_number, po_date, quotation_id,
        customer_name, customer_guid, payment_terms_days,
        credit_status, credit_limit_at_order, outstanding_at_order, overdue_at_order,
        subtotal, tax_amount, total, status, received_at, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
      .run(
        orderNumber, customerPoNumber || null, poDate || null, quotationId || null,
        customerName, customerGuid || credit?.guid || null,
        paymentTermsDays ?? credit?.creditPeriodDays ?? 0,
        credit?.status || 'unknown',
        credit?.creditLimit || 0, credit?.outstanding || 0, credit?.overdue || 0,
        t.subtotal, t.taxAmount, t.total,
        receivedAt || todayISO(), notes || null, actor?.id || null
      );
    const id = info.lastInsertRowid;
    writeLines(id, lines);

    if (quotationId) {
      db.prepare(`UPDATE quotations SET status = 'accepted', updated_at = datetime('now')
                  WHERE id = ? AND status IN ('sent', 'draft')`).run(quotationId);
    }
    logEvent(id, id, 'open', actor, `${orderNumber} received${customerPoNumber ? ` against PO ${customerPoNumber}` : ''}`);
    return getOrder(id);
  })();
}

/** Prefill an order from an accepted quotation, keeping the agreed rates. */
export function orderDraftFromQuotation(quotationId) {
  const q = getQuotation(quotationId);
  if (!q) return null;
  return {
    quotationId: q.id,
    quoteNumber: q.quote_number,
    customerName: q.customer_name,
    customerGuid: q.customer_guid,
    lines: q.lines.map((l) => ({
      itemName: l.item_name, itemGuid: l.item_guid, itemCode: l.item_code,
      brand: l.brand, hsn: l.hsn,
      qty: l.qty, units: l.units,
      // The quoted rate is the agreed rate: discount is already inside it.
      rate: Math.round(l.rate * (1 - (l.discount_pct || 0) / 100) * 100) / 100,
      gstRate: l.gst_rate,
    })),
  };
}

export function updateOrder(id, input, actor) {
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!existing) return null;
  if (existing.status === 'cancelled') throw new Error(`${existing.order_number} is cancelled.`);
  if (existing.status !== 'open') {
    throw new Error(
      `${existing.order_number} has already been dispatched against. Adjust the dispatch instead of the order.`
    );
  }

  const lines = input.lines ?? getLines(id).map(toLineInput);
  const t = totalsFor(asPricing(lines));

  db.prepare(`
    UPDATE orders SET customer_po_number = COALESCE(?, customer_po_number),
      po_date = COALESCE(?, po_date), payment_terms_days = COALESCE(?, payment_terms_days),
      notes = COALESCE(?, notes), subtotal = ?, tax_amount = ?, total = ?,
      updated_at = datetime('now')
    WHERE id = ?`)
    .run(input.customerPoNumber ?? null, input.poDate ?? null,
      input.paymentTermsDays ?? null, input.notes ?? null,
      t.subtotal, t.taxAmount, t.total, id);

  if (input.lines) writeLines(id, input.lines);
  return getOrder(id);
}

export function cancelOrder(id, reason, actor) {
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!existing) return null;
  if (existing.status === 'part_dispatched' || existing.status === 'dispatched') {
    throw new Error(`${existing.order_number} has already shipped in part or full and cannot be cancelled.`);
  }
  db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_reason = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(reason || null, id);
  logEvent(id, id, 'cancelled', actor, reason);
  return getOrder(id);
}

const toLineInput = (r) => ({
  itemName: r.item_name, itemGuid: r.item_guid, itemCode: r.item_code,
  qty: r.qty_ordered, units: r.units, rate: r.rate, gstRate: r.gst_rate,
  brand: r.brand, hsn: r.hsn, notes: r.notes,
});

/** Order lines with how much of each has actually gone out. */
export function getLines(orderId) {
  return db
    .prepare(`
      SELECT ol.*, COALESCE(sent.qty, 0) AS qty_dispatched,
             ol.qty_ordered - COALESCE(sent.qty, 0) AS qty_pending
      FROM order_lines ol
      LEFT JOIN (
        SELECT dl.order_line_id, SUM(dl.qty_dispatched) AS qty
        FROM dispatch_lines dl
        JOIN dispatches d ON d.id = dl.dispatch_id
        WHERE d.status IN ('dispatched', 'delivered')
        GROUP BY dl.order_line_id
      ) sent ON sent.order_line_id = ol.id
      WHERE ol.order_id = ? ORDER BY ol.line_no`)
    .all(orderId);
}

export function getOrder(id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  const lines = getLines(id);
  const events = db
    .prepare(`SELECT * FROM pipeline_events WHERE order_id = ? ORDER BY id`)
    .all(id);
  const dispatches = db
    .prepare('SELECT * FROM dispatches WHERE order_id = ? ORDER BY id')
    .all(id);

  return {
    ...order,
    status: deriveStatus(id) || order.status,
    lines,
    dispatches,
    events,
    // Live position now, alongside the snapshot taken when it was received.
    creditNow: customerCredit(order.customer_name, 0),
    quotation: order.quotation_id
      ? db.prepare('SELECT id, quote_number, version FROM quotations WHERE id = ?').get(order.quotation_id)
      : null,
  };
}

export function listOrders({ status = '', search = '', limit = 100 } = {}) {
  const where = [];
  const params = { limit };
  if (status) { where.push('o.status = @status'); params.status = status; }
  if (search) {
    where.push('(o.order_number LIKE @q OR o.customer_name LIKE @q OR o.customer_po_number LIKE @q)');
    params.q = `%${search}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`
      SELECT o.*, (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id) AS line_count
      FROM orders o ${clause} ORDER BY o.id DESC LIMIT @limit`)
    .all(params);
}

export function orderSummary() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM orders GROUP BY status').all();
  const by = Object.fromEntries(rows.map((r) => [r.status, r]));
  return {
    byStatus: by,
    openCount: by.open?.n || 0,
    openValue: by.open?.value || 0,
    flagged: db
      .prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'open' AND credit_status != 'within'`)
      .get().n,
  };
}

export { refreshStatus };
