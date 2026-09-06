/**
 * Purchase-order ingest.
 *
 * The one endpoint reachable without a session, so it is the one place worth
 * being careful about. It exists so the existing Gmail -> Apps Script scrape
 * can push each new purchase order straight in, rather than this application
 * holding Google credentials and polling a sheet.
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
    res.status(400).json({ error: err.message });
  }
});
