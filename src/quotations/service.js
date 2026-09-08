/**
 * Quotations — the Phase 2 stage that replaces the standalone quotation tool.
 *
 * What the existing browser tool does well is kept: the same line fields, the
 * same discount-then-GST maths, the same copy-for-email output. What it cannot
 * do is added: a customer, a quote number, revisions that are kept rather than
 * overwritten, and a record that outlives one browser's localStorage.
 */
import { db } from '../db/index.js';
import { queueQuotation, queue } from '../sheets/store.js';
import { mintNumber } from '../lib/numbering.js';
import { todayISO, addDaysISO } from '../lib/dates.js';

const nowIso = () => new Date().toISOString();

/**
 * How long a quotation stands. The default terms text quotes the same number,
 * so both come from here and cannot drift apart.
 */
export const QUOTE_VALIDITY_DAYS = 15;

/**
 * Resolve a quotation's two dates.
 *
 * Whichever of the two was edited last wins:
 *   - the expiry was set by hand  -> keep it, it is a deliberate date
 *   - the quotation date moved    -> the expiry goes back to date + 15 days,
 *                                    discarding any earlier custom value
 *
 * So a custom expiry only survives while it is the more recent decision. This
 * lives in the service rather than the browser so it holds however the record
 * is changed, including an API call that sends only one of the two.
 *
 * It also means nothing has to be stored to remember which was edited last: an
 * expiry that is not date + 15 can only have got that way by being set after
 * the date was, so the values alone say which it was.
 */
function datesFor({ quoteDate, validUntil } = {}, existing = null) {
  const date = quoteDate || existing?.quote_date || todayISO();
  const derived = addDaysISO(date, QUOTE_VALIDITY_DAYS);

  const dateChanged = Boolean(quoteDate) && quoteDate !== existing?.quote_date;
  const expiryGiven = Boolean(validUntil) && validUntil !== existing?.valid_until;

  if (expiryGiven) return { quoteDate: date, validUntil };
  if (dateChanged) return { quoteDate: date, validUntil: derived };
  return { quoteDate: date, validUntil: validUntil || existing?.valid_until || derived };
}

export function nextQuoteNumber() {
  return mintNumber({ prefix: 'BE/Q', table: 'quotations', column: 'quote_number', what: 'quotation number' });
}

/**
 * Line maths, identical to the existing tool: discount comes off the gross,
 * GST is charged on what is left.
 */
export function priceLine(line) {
  const qty = Number(line.qty) || 0;
  const rate = Number(line.rate) || 0;
  const discount = Number(line.discountPct) || 0;
  const gstRate = Number(line.gstRate) || 0;
  const gross = qty * rate;
  const taxable = gross * (1 - discount / 100);
  const gstAmount = (taxable * gstRate) / 100;
  return { gross, taxable, gstAmount, total: taxable + gstAmount };
}

export function totalsFor(lines) {
  return lines.reduce(
    (acc, l) => {
      const p = priceLine(l);
      acc.subtotal += p.taxable;
      acc.taxAmount += p.gstAmount;
      acc.total += p.total;
      return acc;
    },
    { subtotal: 0, taxAmount: 0, total: 0 }
  );
}

function writeLines(quotationId, lines) {
  db.prepare('DELETE FROM quotation_lines WHERE quotation_id = ?').run(quotationId);
  const insert = db.prepare(`
    INSERT INTO quotation_lines (quotation_id, line_no, item_name, item_guid, item_code,
      qty, units, list_rate, discount_pct, rate, gst_rate, amount, brand, hsn, remarks)
    VALUES (@quotation_id, @line_no, @item_name, @item_guid, @item_code,
      @qty, @units, @list_rate, @discount_pct, @rate, @gst_rate, @amount, @brand, @hsn, @remarks)`);
  lines.forEach((l, i) => {
    const p = priceLine(l);
    insert.run({
      quotation_id: quotationId,
      line_no: i + 1,
      item_name: l.itemName || '',
      item_guid: l.itemGuid || null,
      item_code: l.itemCode || null,
      qty: Number(l.qty) || 0,
      units: l.units || 'Nos',
      list_rate: Number(l.listRate) || 0,
      discount_pct: Number(l.discountPct) || 0,
      rate: Number(l.rate) || 0,
      gst_rate: Number(l.gstRate) || 0,
      amount: p.taxable,
      brand: l.brand || null,
      hsn: l.hsn || null,
      remarks: l.remarks || null,
    });
  });
}

function logEvent(entity, id, to, actor, note) {
  const info = db.prepare(
    `INSERT INTO pipeline_events (entity_type, entity_id, from_stage, to_stage, note, actor_id, actor_name)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`
  ).run(entity, id, to, note || null, actor?.id || null, actor?.name || null);
  queue('pipeline_events', info.lastInsertRowid);
}

export function createQuotation(
  {
    customerName, customerGuid, rfqId, lines = [], notes, terms, quoteDate, validUntil,
    // Where it came from, mirroring an order. An enquiry that arrived by mail
    // keys on the message it came from, and that key is uniquely indexed, so
    // the same mail can never quietly burn two quote numbers.
    source = 'manual', sourceRef = null, documentUrl = null,
  },
  actor
) {
  const t = totalsFor(lines);
  const quoteNumber = nextQuoteNumber();
  const d = datesFor({ quoteDate, validUntil });
  const info = db
    .prepare(`
      INSERT INTO quotations (quote_number, version, is_current, rfq_id, customer_name, customer_guid,
        status, quote_date, valid_until, subtotal, tax_amount, total, notes,
        source, source_ref, document_url)
      VALUES (?, 1, 1, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(quoteNumber, rfqId || null, customerName, customerGuid || null, d.quoteDate, d.validUntil,
      t.subtotal, t.taxAmount, t.total, notes ?? terms ?? null,
      source, sourceRef, documentUrl);
  const id = info.lastInsertRowid;
  writeLines(id, lines);
  logEvent('quotation', id, 'draft', actor, `${quoteNumber} created`);
  queueQuotation(id);
  return getQuotation(id);
}

export function updateQuotation(id, { customerName, customerGuid, lines, notes, quoteDate, validUntil }, actor) {
  const existing = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!existing) return null;
  if (existing.status !== 'draft') {
    // A quotation that has gone to the customer is a record of what was said.
    // Changing it in place would destroy exactly the evidence this stage exists
    // to keep — revise it instead, which keeps both versions.
    throw new Error(`${existing.quote_number} has already been sent. Create a revision instead.`);
  }
  const nextLines = lines ?? getLines(id);
  const t = totalsFor(nextLines);
  const d = datesFor({ quoteDate, validUntil }, existing);
  db.prepare(`
    UPDATE quotations SET customer_name = COALESCE(?, customer_name),
      customer_guid = COALESCE(?, customer_guid), notes = COALESCE(?, notes),
      quote_date = ?, valid_until = ?,
      subtotal = ?, tax_amount = ?, total = ?, updated_at = datetime('now')
    WHERE id = ?`)
    .run(customerName ?? null, customerGuid ?? null, notes ?? null,
      d.quoteDate, d.validUntil, t.subtotal, t.taxAmount, t.total, id);
  if (lines) writeLines(id, lines);
  queueQuotation(id);
  return getQuotation(id);
}

/** A revision is a new row, never an edit. Both versions stay readable. */
export function reviseQuotation(id, actor) {
  const current = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!current) return null;
  const lines = getLines(id);

  return db.transaction(() => {
    db.prepare(`UPDATE quotations SET is_current = 0, status = 'superseded', updated_at = datetime('now') WHERE quote_number = ? AND is_current = 1`)
      .run(current.quote_number);
    // A revision goes out today, so it is re-dated and its validity restarts.
    const d = datesFor({});
    // The revision keeps where the quotation came from, but not the key that
    // came with it: source_ref belongs to the one row the mail actually
    // created, and is uniquely indexed.
    const info = db.prepare(`
      INSERT INTO quotations (quote_number, version, is_current, rfq_id, customer_name, customer_guid,
        status, quote_date, valid_until, subtotal, tax_amount, total, notes, source, document_url)
      VALUES (?, ?, 1, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(current.quote_number, current.version + 1, current.rfq_id, current.customer_name,
        current.customer_guid, d.quoteDate, d.validUntil, current.subtotal, current.tax_amount,
        current.total, current.notes, current.source || 'manual', current.document_url || null);
    const newId = info.lastInsertRowid;
    writeLines(newId, lines.map(toLineInput));
    logEvent('quotation', newId, 'draft', actor, `revision ${current.version + 1} of ${current.quote_number}`);
    // Both rows go up: the revision, and the one it just superseded. Pushing
    // only the new one would leave the sheet showing two current versions of
    // the same quotation, which is worse than showing neither.
    queueQuotation(current.id);
    queueQuotation(newId);
    return getQuotation(newId);
  })();
}

export function setStatus(id, status, { lostReason } = {}, actor) {
  const allowed = ['draft', 'sent', 'accepted', 'lost'];
  if (!allowed.includes(status)) throw new Error(`Unknown status '${status}'`);
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!q) return null;

  db.prepare(`UPDATE quotations SET status = ?, lost_reason = ?, sent_at = COALESCE(sent_at, ?), updated_at = datetime('now') WHERE id = ?`)
    .run(status, status === 'lost' ? lostReason || null : null,
      status === 'sent' ? nowIso() : q.sent_at, id);

  if (q.rfq_id && status === 'sent') {
    db.prepare(`UPDATE rfqs SET status = 'quoted', updated_at = datetime('now') WHERE id = ? AND status = 'open'`).run(q.rfq_id);
  }
  logEvent('quotation', id, status, actor, status === 'lost' ? lostReason : null);
  queueQuotation(id);
  return getQuotation(id);
}

const toLineInput = (r) => ({
  itemName: r.item_name, itemGuid: r.item_guid, itemCode: r.item_code,
  qty: r.qty, units: r.units, listRate: r.list_rate,
  discountPct: r.discount_pct, rate: r.rate, gstRate: r.gst_rate,
  brand: r.brand, hsn: r.hsn, remarks: r.remarks,
});

export function getLines(quotationId) {
  return db
    .prepare('SELECT * FROM quotation_lines WHERE quotation_id = ? ORDER BY line_no')
    .all(quotationId);
}

export function getQuotation(id) {
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!q) return null;
  const lines = getLines(id).map((l) => ({ ...l, ...priceLine(toLineInput(l)) }));
  const versions = db
    .prepare('SELECT id, version, status, created_at, total FROM quotations WHERE quote_number = ? ORDER BY version')
    .all(q.quote_number);
  const events = db
    .prepare(`SELECT * FROM pipeline_events WHERE entity_type = 'quotation' AND entity_id = ? ORDER BY id`)
    .all(id);
  return { ...q, lines, versions, events, totals: totalsFor(lines.map(toLineInput)) };
}

export function listQuotations({ status = '', search = '', limit = 100 } = {}) {
  const where = ['is_current = 1'];
  const params = {};
  if (status) { where.push('status = @status'); params.status = status; }
  if (search) {
    where.push('(quote_number LIKE @q OR customer_name LIKE @q)');
    params.q = `%${search}%`;
  }
  return db
    .prepare(`
      SELECT q.*, (SELECT COUNT(*) FROM quotation_lines l WHERE l.quotation_id = q.id) AS line_count
      FROM quotations q WHERE ${where.join(' AND ')}
      ORDER BY q.updated_at DESC LIMIT @limit`)
    .all({ ...params, limit });
}
