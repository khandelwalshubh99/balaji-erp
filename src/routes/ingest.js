/**
 * Gmail ingest.
 *
 * The only endpoints reachable without a session, so the one place worth being
 * careful about. They exist so an Apps Script sweep of Gmail can push mail
 * straight in, rather than this application holding Google credentials and
 * polling a sheet.
 *
 *   POST /api/ingest/mail            every mail, classified and threaded here
 *   POST /api/ingest/purchase-order  the older single-purpose push, still live
 *
 * Rules it follows:
 *   - Fails CLOSED. No INGEST_TOKEN configured means the endpoint is off.
 *   - Constant-time token comparison.
 *   - A repeat of the same sourceRef answers 200 "duplicate", not an error, so
 *     a script retrying does not spin or fill its log with failures.
 *   - Never trusts the payload beyond plain data: a purchase order arrives with
 *     a header and a document link, and its items are keyed in afterwards.
 */
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { matchCustomer } from '../customers/service.js';
import * as orders from '../orders/service.js';
import { ingestBatch } from '../mail/service.js';

export const ingestRouter = Router();

function tokenMatches(given) {
  const expected = config.ingestToken;
  if (!expected) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // length; compare padded buffers of equal size instead.
  const len = Math.max(a.length, b.length);
  return timingSafeEqual(Buffer.concat([a], len), Buffer.concat([b], len)) && a.length === b.length;
}

function authorise(req, res, next) {
  if (!config.ingestToken) {
    return res.status(503).json({ error: 'Purchase-order ingest is not configured on this server.' });
  }
  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-ingest-token');
  if (!tokenMatches(token)) {
    console.warn(`[ingest] rejected request from ${req.ip}`);
    return res.status(401).json({ error: 'Bad or missing ingest token' });
  }
  next();
}

const str = (v, max = 300) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

/** Accepts a YYYY-MM-DD, or anything Date can read, and normalises it. */
function isoDate(v) {
  const s = str(v, 40);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Only links we are willing to store and later render as an anchor. */
function safeUrl(v) {
  const s = str(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

ingestRouter.get('/api/ingest/ping', authorise, (_req, res) =>
  res.json({ ok: true, service: 'balaji-erp purchase-order ingest' })
);

/**
 * A sweep of Gmail, in one call.
 *
 * Batched because a ten-minute trigger in Apps Script has a fixed budget of
 * URL fetches, and a busy morning is fifty mails. Each message is recorded in
 * its own transaction and gets its own result, so one malformed mail cannot
 * cost the other forty-nine — the script logs that one and moves on.
 *
 * Every result names what happened to that message: created, duplicate, or
 * error, with the id it landed against. That is what lets the script write the
 * ERP's number back onto the Gmail thread as a label.
 */
const MAX_BATCH = 100;

ingestRouter.post('/api/ingest/mail', authorise, (req, res) => {
  const body = req.body || {};
  const messages = Array.isArray(body) ? body : Array.isArray(body.messages) ? body.messages : [body];
  if (!messages.length) return res.status(400).json({ error: 'No messages in this push' });
  if (messages.length > MAX_BATCH) {
    return res.status(413).json({ error: `Too many messages in one push (${messages.length}); send at most ${MAX_BATCH}.` });
  }

  try {
    const out = ingestBatch(messages);
    const minted = out.results.filter((r) => r.minted).length;
    console.log(
      `[mail] ${out.received} in from ${req.ip}: ${out.created} new, ${out.duplicates} already seen, ` +
      `${minted} record${minted === 1 ? '' : 's'} raised, ${out.errors} failed`
    );
    res.json(out);
  } catch (err) {
    console.error('[mail] batch failed:', err.message);
    // 503, not 500, when the store has not been read yet. The sweep treats a
    // 5xx as the ERP being down: it labels nothing and leaves its watermark
    // where it is, so the same window is swept again once the sheet is back.
    // A 4xx would label these mails ERP/Failed and never retry them, which for
    // a temporary condition is the wrong answer permanently.
    res.status(err.name === 'SheetNotReadyError' ? 503 : 500).json({ error: err.message });
  }
});

ingestRouter.post('/api/ingest/purchase-order', authorise, (req, res) => {
  const body = req.body || {};

  const sourceRef = str(body.sourceRef, 200);
  if (!sourceRef) {
    return res.status(400).json({
      error: 'sourceRef is required — the Gmail message id or Drive file id, so the same PO is never taken twice.',
    });
  }

  const rawCustomer = str(body.customerName, 200);
  if (!rawCustomer) return res.status(400).json({ error: 'customerName is required' });

  // Idempotent: the same source answers success, so a retrying script settles.
  const existing = db.prepare('SELECT id, order_number FROM orders WHERE source_ref = ?').get(sourceRef);
  if (existing) {
    return res.json({
      status: 'duplicate',
      orderId: existing.id,
      orderNumber: existing.order_number,
      message: 'Already recorded from this source.',
    });
  }

  const match = matchCustomer(rawCustomer);
  const poNumber = str(body.poNumber, 100);

  try {
    const order = orders.createOrder(
      {
        customerName: match.matched ? match.name : rawCustomer,
        customerGuid: match.guid,
        customerPoNumber: poNumber,
        poDate: isoDate(body.poDate),
        receivedAt: isoDate(body.receivedAt),
        notes: str(body.notes, 2000),
        lines: [],
        source: 'email',
        sourceRef,
        documentUrl: safeUrl(body.documentUrl),
        // A same-numbered PO from a different email is reported back rather
        // than blocked — the script cannot judge whether it is an amendment.
        allowDuplicate: true,
      },
      { id: null, name: 'Gmail ingest' }
    );

    const warnings = [];
    if (!match.matched) {
      warnings.push(
        match.method === 'ambiguous'
          ? `"${rawCustomer}" matches more than one ledger (${match.candidates.join(', ')}) — left unassigned.`
          : `"${rawCustomer}" is not a customer in Tally — left unassigned.`
      );
    }
    const soft = orders.findDuplicates({
      customerName: order.customer_name,
      customerPoNumber: poNumber,
      total: 0,
      excludeId: order.id,
    });
    for (const d of soft) warnings.push(d.reason);

    console.log(`[ingest] ${order.order_number} from ${sourceRef}${warnings.length ? ` (${warnings.length} warning)` : ''}`);

    res.json({
      status: 'created',
      orderId: order.id,
      orderNumber: order.order_number,
      customerMatched: match.matched,
      customer: order.customer_name,
      needsLines: true,
      warnings,
    });
  } catch (err) {
    console.error('[ingest] failed:', err.message);
    // See the mail endpoint above: "not read yet" is temporary and must come
    // back as a retryable 5xx rather than a permanent refusal.
    res.status(err.name === 'SheetNotReadyError' ? 503 : 400).json({ error: err.message });
  }
});
