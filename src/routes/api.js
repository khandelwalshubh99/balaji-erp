import { Router } from 'express';
import { config } from '../config.js';
import * as q from '../db/queries.js';
import { runSync, syncStatus } from '../sync/engine.js';
import { tally } from '../tally/client.js';
import { searchCatalogue, catalogueFacets, matchSummary, unmatchedItems, orphanStockItems, matchCatalogue, lastRateFor } from '../catalogue/match.js';
import * as quotes from '../quotations/service.js';
import { listCustomers, customerCredit, knownSegments, listCustomerSegments, setCustomerSegment } from '../customers/service.js';
import * as orders from '../orders/service.js';
import * as dispatch from '../dispatch/service.js';
import * as invoices from '../invoices/service.js';
import * as mail from '../mail/service.js';
import * as analytics from '../analytics/service.js';
import { getSetting, setSetting, parseSheetId, sheetUrlFor } from '../settings/service.js';
import * as sheets from '../sheets/store.js';
import { renderQuotationHtml, renderQuotationText, DEFAULT_TERMS } from '../quotations/render.js';
import { QUOTE_VALIDITY_DAYS } from '../quotations/service.js';

export const apiRouter = Router();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

apiRouter.get('/overview', (_req, res) => res.json(q.overview()));

// --- dashboard (the commercial view) ----------------------------------------
/**
 * One call, because these numbers are one question.
 *
 * Splitting it per metric would let the tier table be built from a different
 * window than the gap lists that read off it, and "high tier customers not
 * billed" would then disagree with the tier column beside it.
 */
apiRouter.get('/dashboard', (req, res) => {
  res.json(
    analytics.dashboard({
      month: req.query.month ? String(req.query.month) : undefined,
      windowMonths: Math.min(24, Math.max(2, num(req.query.window, 6))),
      trendMonths: Math.min(36, Math.max(3, num(req.query.trend, 12))),
    })
  );
});

apiRouter.get('/dashboard/brands', (req, res) =>
  res.json(
    analytics.brandSales({
      month: req.query.month ? String(req.query.month) : undefined,
      months: Math.min(24, Math.max(2, num(req.query.months, 6))),
    })
  )
);

apiRouter.get('/stock', (req, res) => {
  const { search = '', category = '', status = 'all', sort = 'name' } = req.query;
  res.json({
    ...q.stockItems({
      search: String(search),
      category: String(category),
      status: String(status),
      sort: String(sort),
      limit: Math.min(500, num(req.query.limit, 200)),
      offset: num(req.query.offset, 0),
    }),
    categories: q.stockCategories(),
    summary: q.stockSummary(),
  });
});

apiRouter.get('/receivables', (_req, res) => res.json(q.receivables()));

apiRouter.get('/tally-orders', (req, res) => res.json(q.orderSnapshot({ days: num(req.query.days, 45) })));

apiRouter.get('/reorder', (req, res) => res.json({ items: q.reorderList(num(req.query.limit, 60)) }));

// --- Tally / Phase 0 --------------------------------------------------------
apiRouter.get('/tally/target', (_req, res) =>
  res.json({
    ...tally.target(),
    simulated: config.tally.mode === 'simulated',
    syncIntervalMinutes: config.sync.intervalMinutes,
  })
);

apiRouter.get('/tally/ping', async (_req, res) => res.json(await tally.ping()));

/** The Phase 0 console: send any of the app's own requests and see raw XML. */
const PROBES = {
  companies: { label: 'List of Companies', build: () => tally.requests.listCompanies() },
  ledgers: { label: 'Ledgers & parties', build: () => tally.requests.listLedgers(config.tally.company) },
  stock: { label: 'Stock items', build: () => tally.requests.listStockItems(config.tally.company) },
  bills: { label: 'Bills receivable', build: () => tally.requests.listBillsReceivable(config.tally.company) },
  daybook: {
    label: 'Day book (last 7 days)',
    build: () => tally.requests.dayBook(config.tally.company, new Date(Date.now() - 7 * 86400000), new Date()),
  },
};

apiRouter.get('/tally/probes', (_req, res) =>
  res.json({ probes: Object.entries(PROBES).map(([key, p]) => ({ key, label: p.label })) })
);

apiRouter.post('/tally/probe', async (req, res) => {
  const key = String(req.body?.probe || '');
  // Own keys only. A plain object answers for `constructor`, `toString`,
  // `valueOf` and `__proto__` with something inherited and truthy, which walked
  // straight past a `!probe` guard and then died on `.build()`. In an async
  // handler Express 4 does not catch that, so the request never got a response
  // at all — it sat open until the browser gave up.
  const probe = Object.hasOwn(PROBES, key) ? PROBES[key] : null;
  if (!probe) return res.status(400).json({ error: `Unknown probe '${key}'` });
  // Declared out here so the failure path can still show what was sent — or
  // report that building it is what failed, when this is still null.
  let request = null;
  try {
    // Built inside the try, so a builder that throws is reported like any other
    // probe failure rather than hanging the request.
    request = probe.build();
    const t0 = Date.now();
    const out = await tally.raw(request);
    res.json({
      ok: true,
      label: probe.label,
      request,
      response: out.xml.length > 200000 ? `${out.xml.slice(0, 200000)}\n... [truncated]` : out.xml,
      bytes: Buffer.byteLength(out.xml),
      elapsedMs: Date.now() - t0,
    });
  } catch (err) {
    res.json({ ok: false, label: probe.label, request, error: err.message });
  }
});

// --- sync -------------------------------------------------------------------
apiRouter.get('/sync/status', (_req, res) =>
  res.json({ ...syncStatus(), last: q.lastSync(), history: q.syncHistory(15) })
);

apiRouter.post('/sync/run', async (_req, res) => {
  const result = await runSync('manual');
  res.json(result);
});

// --- catalogue --------------------------------------------------------------
apiRouter.get('/catalogue', (req, res) => {
  const { search = '', brand = '', category = '', stocked = 'all', customer = '' } = req.query;
  res.json({
    ...searchCatalogue({
      search: String(search), brand: String(brand), category: String(category),
      stocked: String(stocked), customer: String(customer),
      limit: Math.min(200, num(req.query.limit, 50)),
    }),
    ...catalogueFacets(),
    summary: matchSummary(),
  });
});

apiRouter.get('/catalogue/unmatched', (req, res) =>
  res.json({
    notStocked: unmatchedItems(num(req.query.limit, 100)),
    notQuotable: orphanStockItems(num(req.query.limit, 100)),
    summary: matchSummary(),
  })
);

apiRouter.post('/catalogue/match', (_req, res) => res.json(matchCatalogue()));

apiRouter.get('/catalogue/last-rate', (req, res) =>
  res.json({ lastRate: lastRateFor(String(req.query.customer || ''), String(req.query.guid || '')) })
);

// --- quotations -------------------------------------------------------------
const actorOf = (req) => req.session?.user || null;

apiRouter.get('/customers', (req, res) =>
  res.json({ customers: listCustomers(String(req.query.search || '')) })
);

/**
 * Which industry each customer is in, and the labels to choose from.
 *
 * Not a path parameter on the customer, because a ledger name is free text
 * that can contain a slash — putting it in the URL is how "M/s Sharma Tools"
 * becomes a 404 nobody can explain.
 */
apiRouter.get('/customer-segments', (_req, res) =>
  res.json({ assignments: listCustomerSegments(), known: knownSegments() })
);

apiRouter.put('/customer-segments', (req, res) => {
  try {
    const out = setCustomerSegment(
      String(req.body?.customerName || ''),
      String(req.body?.segment ?? ''),
      actorOf(req)
    );
    res.json({ ...out, known: knownSegments() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

apiRouter.get('/customers/:name/credit', (req, res) => {
  const credit = customerCredit(req.params.name, Number(req.query.value) || 0);
  if (!credit) return res.status(404).json({ error: 'No such customer in the synced ledgers' });
  res.json(credit);
});

apiRouter.get('/quotations', (req, res) =>
  res.json({
    quotations: quotes.listQuotations({
      status: String(req.query.status || ''),
      search: String(req.query.search || ''),
      limit: num(req.query.limit, 100),
    }),
    defaultTerms: DEFAULT_TERMS,
    validityDays: QUOTE_VALIDITY_DAYS,
  })
);

apiRouter.post('/quotations', (req, res) => {
  const { customerName } = req.body || {};
  if (!customerName) return res.status(400).json({ error: 'A customer is required' });
  res.json(quotes.createQuotation(req.body, actorOf(req)));
});

apiRouter.get('/quotations/:id', (req, res) => {
  const q = quotes.getQuotation(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'No such quotation' });
  res.json({ ...q, html: renderQuotationHtml(q), text: renderQuotationText(q) });
});

apiRouter.put('/quotations/:id', (req, res) => {
  try {
    const q = quotes.updateQuotation(Number(req.params.id), req.body || {}, actorOf(req));
    if (!q) return res.status(404).json({ error: 'No such quotation' });
    res.json(q);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

apiRouter.post('/quotations/:id/revise', (req, res) => {
  const q = quotes.reviseQuotation(Number(req.params.id), actorOf(req));
  if (!q) return res.status(404).json({ error: 'No such quotation' });
  res.json(q);
});

apiRouter.post('/quotations/:id/status', (req, res) => {
  try {
    const q = quotes.setStatus(Number(req.params.id), String(req.body?.status || ''),
      { lostReason: req.body?.lostReason }, actorOf(req));
    if (!q) return res.status(404).json({ error: 'No such quotation' });
    res.json(q);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- orders (Phase 2 "Order Received") --------------------------------------
apiRouter.get('/orders', (req, res) =>
  res.json({
    orders: orders.listOrders({
      status: String(req.query.status || ''),
      search: String(req.query.search || ''),
      limit: num(req.query.limit, 100),
    }),
    summary: orders.orderSummary(),
  })
);

apiRouter.get('/orders/new', (req, res) => {
  const fromQuote = req.query.quotation ? orders.orderDraftFromQuotation(Number(req.query.quotation)) : null;
  if (req.query.quotation && !fromQuote) return res.status(404).json({ error: 'No such quotation' });
  res.json({ orderNumber: orders.nextOrderNumber(), draft: fromQuote });
});

apiRouter.get('/orders/:id', (req, res) => {
  const order = orders.getOrder(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'No such order' });
  // Joined here rather than inside the order service, so that orders know
  // nothing about invoicing. The dependency only ever needs to run one way.
  res.json({ ...order, invoices: invoices.forOrder(order.id) });
});

apiRouter.get('/orders/check-duplicate', (req, res) =>
  res.json({
    duplicates: orders.findDuplicates({
      customerName: String(req.query.customer || ''),
      customerPoNumber: String(req.query.po || ''),
      sourceRef: req.query.sourceRef ? String(req.query.sourceRef) : null,
      total: Number(req.query.total) || 0,
    }),
  })
);

apiRouter.post('/orders', (req, res) => {
  try {
    res.json(orders.createOrder(req.body || {}, actorOf(req)));
  } catch (err) {
    // A possible duplicate is a question for the user, not a failure.
    if (err.code === 'DUPLICATE' || err.code === 'POSSIBLE_DUPLICATE') {
      return res.status(409).json({
        error: err.message,
        code: err.code,
        duplicates: (err.duplicates || []).map((d) => ({
          kind: d.kind, conclusive: d.conclusive, reason: d.reason,
          orderId: d.order.id, orderNumber: d.order.order_number,
        })),
      });
    }
    res.status(400).json({ error: err.message });
  }
});

apiRouter.put('/orders/:id', (req, res) => {
  try {
    const order = orders.updateOrder(Number(req.params.id), req.body || {}, actorOf(req));
    if (!order) return res.status(404).json({ error: 'No such order' });
    res.json(order);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

apiRouter.post('/orders/:id/cancel', (req, res) => {
  try {
    const order = orders.cancelOrder(Number(req.params.id), req.body?.reason, actorOf(req));
    if (!order) return res.status(404).json({ error: 'No such order' });
    res.json(order);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});


// --- mail -------------------------------------------------------------------
// Reading and deciding. Mail arrives through /api/ingest/mail, which carries
// its own shared-secret check; everything below is behind the session.
apiRouter.get('/mail', (req, res) =>
  res.json({
    threads: mail.listThreads({
      kind: String(req.query.kind || ''),
      search: String(req.query.search || ''),
      limit: num(req.query.limit, 100),
    }),
    summary: mail.mailSummary(),
  })
);

apiRouter.get('/mail/senders', (req, res) =>
  res.json({ senders: mail.unresolvedSenders(num(req.query.limit, 50)) })
);

apiRouter.get('/mail/:id', (req, res) => {
  const thread = mail.getThread(Number(req.params.id));
  if (!thread) return res.status(404).json({ error: 'No such mail thread' });
  res.json(thread);
});

/** The review queue's one action: say what this is, and let it take a number. */
apiRouter.post('/mail/:id/classify', (req, res) => {
  try {
    const thread = mail.classifyThread(Number(req.params.id), String(req.body?.kind || ''), actorOf(req));
    if (!thread) return res.status(404).json({ error: 'No such mail thread' });
    res.json(mail.getThread(thread.id));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

/** Attach to a record that already exists rather than raising a new one. */
apiRouter.post('/mail/:id/link', (req, res) => {
  try {
    const thread = mail.linkThread(
      Number(req.params.id),
      { orderId: Number(req.body?.orderId) || null, quotationId: Number(req.body?.quotationId) || null },
      actorOf(req)
    );
    if (!thread) return res.status(404).json({ error: 'No such mail thread' });
    res.json(mail.getThread(thread.id));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

/** Bind a sender to a Tally ledger, once, for every mail from them after. */
apiRouter.post('/mail/party', (req, res) => {
  try {
    res.json(mail.bindParty(
      {
        scope: String(req.body?.scope || ''),
        value: String(req.body?.value || ''),
        customerName: String(req.body?.customerName || ''),
      },
      actorOf(req)
    ));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// --- picking, dispatch and the LR (Phase 2c) --------------------------------
/**
 * The dispatch screen loads three things at once, because they are one
 * question: what is going out, what has gone, and what is waiting on paperwork.
 */
apiRouter.get('/dispatches', (req, res) =>
  res.json({
    dispatches: dispatch.listDispatches({
      status: String(req.query.status || ''),
      search: String(req.query.search || ''),
      orderId: req.query.orderId ? Number(req.query.orderId) : null,
      limit: num(req.query.limit, 100),
    }),
    readyToPick: dispatch.readyToPick({ limit: num(req.query.limit, 100) }),
    summary: dispatch.dispatchSummary(),
  })
);

apiRouter.get('/dispatches/:id', (req, res) => {
  const d = dispatch.getDispatch(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'No such dispatch' });
  const invoice = invoices.forOrder(d.order_id).find((i) => i.dispatch_id === d.id) || null;
  res.json({ ...d, invoice, invoiceValue: invoices.valueOfDispatch(d.id) });
});

apiRouter.post('/dispatches', (req, res) => {
  const orderId = Number(req.body?.orderId);
  if (!orderId) return res.status(400).json({ error: 'An order is required to raise a pick list.' });
  res.json(dispatch.createDispatch(orderId, actorOf(req)));
});

apiRouter.put('/dispatches/:id', (req, res) => {
  const d = dispatch.updateDispatch(Number(req.params.id), req.body || {}, actorOf(req));
  if (!d) return res.status(404).json({ error: 'No such dispatch' });
  res.json(d);
});

apiRouter.post('/dispatches/:id/status', (req, res) => {
  const d = dispatch.setStatus(Number(req.params.id), String(req.body?.status || ''), actorOf(req));
  if (!d) return res.status(404).json({ error: 'No such dispatch' });
  res.json(d);
});

apiRouter.post('/dispatches/:id/pod', (req, res) => {
  const d = dispatch.setPod(Number(req.params.id), Boolean(req.body?.received), actorOf(req));
  if (!d) return res.status(404).json({ error: 'No such dispatch' });
  res.json(d);
});

/** Only ever a pick list. The service refuses anything that has left. */
apiRouter.delete('/dispatches/:id', (req, res) => {
  const out = dispatch.abandon(Number(req.params.id), actorOf(req));
  if (!out) return res.status(404).json({ error: 'No such dispatch' });
  res.json(out);
});

// --- invoices and the payment clock (Phase 2d) ------------------------------
/**
 * Everything the invoice screen needs, in one call.
 *
 * The payment position on each row is Tally's current answer, worked out as
 * the response is built. Nothing about payment is stored here, so there is
 * nothing that can be stale.
 */
apiRouter.get('/invoices', (req, res) =>
  res.json({
    invoices: invoices.listInvoices({
      status: String(req.query.status || ''),
      search: String(req.query.search || ''),
      limit: num(req.query.limit, 200),
    }),
    awaitingInvoice: invoices.awaitingInvoice({ limit: num(req.query.limit, 100) }),
    summary: invoices.invoiceSummary(),
  })
);

apiRouter.get('/invoices/:id', (req, res) => {
  const inv = invoices.getInvoice(Number(req.params.id));
  if (!inv) return res.status(404).json({ error: 'No such invoice' });
  res.json(inv);
});

apiRouter.post('/invoices', (req, res) => res.json(invoices.raiseInvoice(req.body || {}, actorOf(req))));

apiRouter.put('/invoices/:id', (req, res) => {
  const inv = invoices.updateInvoice(Number(req.params.id), req.body || {}, actorOf(req));
  if (!inv) return res.status(404).json({ error: 'No such invoice' });
  res.json(inv);
});

/** Look for the bill again now, rather than waiting for the next sync. */
apiRouter.post('/invoices/:id/match', (req, res) => {
  const out = invoices.matchInvoice(Number(req.params.id), { actor: actorOf(req) });
  if (!out) return res.status(404).json({ error: 'No such invoice' });
  res.json({ ...out, invoice: invoices.getInvoice(Number(req.params.id)) });
});

/** Link by hand, or unlink by sending no ref. See linkInvoice(). */
apiRouter.post('/invoices/:id/link', (req, res) => {
  const inv = invoices.linkInvoice(Number(req.params.id), req.body?.billRef || null, actorOf(req));
  if (!inv) return res.status(404).json({ error: 'No such invoice' });
  res.json(inv);
});

apiRouter.delete('/invoices/:id', (req, res) => {
  const out = invoices.deleteInvoice(Number(req.params.id), actorOf(req));
  if (!out) return res.status(404).json({ error: 'No such invoice' });
  res.json(out);
});

// --- connections ------------------------------------------------------------
/**
 * What this ERP is joined up to, and whether each join is actually live.
 *
 * Two very different things sit here on purpose. Tally is something the app
 * connects OUT to and polls. Gmail is the opposite: the Apps Script pushes IN,
 * and the ERP holds no Google credentials at all — so "connected" for the mail
 * side means the token is set and mail has recently arrived, not that we can
 * reach anything. The screen says so rather than implying a symmetry that does
 * not exist.
 */
apiRouter.get('/connections', (_req, res) => {
  const summary = mail.mailSummary();
  const sheetId = getSetting('mail.sheetId');
  res.json({
    tally: {
      ...tally.target(),
      simulated: config.tally.mode === 'simulated',
      syncIntervalMinutes: config.sync.intervalMinutes,
      lastSync: q.lastSync(),
    },
    mail: {
      // The endpoint fails closed, so no token means the sweep cannot post at
      // all — the single most likely reason for "nothing is arriving".
      ingestConfigured: Boolean(config.ingestToken),
      ownDomains: String(config.mail.ownDomains || '').split(',').map((d) => d.trim()).filter(Boolean),
      ownAddresses: String(config.mail.ownAddresses || '').split(',').map((d) => d.trim()).filter(Boolean),
      sheetId,
      sheetUrl: sheetUrlFor(sheetId),
      sheetUpdatedAt: sheetId ? getSetting('mail.sheetUpdatedAt') : null,
      threads: summary.threads,
      messages: summary.messages,
      needsReview: summary.needsReview,
      lastMessageAt: summary.lastMessageAt,
      lastIngestAt: summary.lastIngestAt,
    },
    // The third connection, and the one that decides whether anything can be
    // raised at all. Tally can be down and the app still works; the sheet
    // being unread holds back every new quotation and order number.
    store: sheets.status(),
  });
});

/**
 * Which sheet this is.
 *
 * Kept separate from the web app URL below because they answer different
 * questions — "which spreadsheet" versus "how do we reach it" — and someone
 * repointing at a copy of the sheet gets one wrong far more often than both.
 */
apiRouter.put('/connections/sheet', (req, res) => {
  const raw = String(req.body?.url || '').trim();
  if (!raw) {
    sheets.saveConnection({ sheetId: null }, actorOf(req));
    return res.json({ sheetId: null, sheetUrl: null });
  }
  const sheetId = parseSheetId(raw);
  if (!sheetId) {
    return res.status(400).json({
      error: 'That is not a Google Sheets link. Paste the whole URL from the address bar, or just the sheet id.',
    });
  }
  sheets.saveConnection({ sheetId }, actorOf(req));
  setSetting('mail.sheetUpdatedAt', new Date().toISOString(), actorOf(req));
  res.json({ sheetId, sheetUrl: sheetUrlFor(sheetId) });
});

// --- the store --------------------------------------------------------------

apiRouter.get('/sheets/status', (_req, res) => res.json(sheets.status()));

apiRouter.put('/sheets/connection', (req, res) => {
  const { webAppUrl, token, sheetId } = req.body || {};
  res.json(sheets.saveConnection({ webAppUrl, token, sheetId }, actorOf(req)));
});

/**
 * Try values before committing to them.
 *
 * Tested against what is in the form rather than what is saved, so a typo in a
 * pasted URL is caught while the person still has it on their clipboard.
 */
apiRouter.post('/sheets/test', async (req, res, next) => {
  try {
    const { webAppUrl, token } = req.body || {};
    const pong = await sheets.ping({ webAppUrl, token });
    res.json({
      ok: true,
      spreadsheetName: pong.spreadsheetName,
      spreadsheetId: pong.spreadsheetId,
      url: pong.url,
      version: pong.version,
      tabs: pong.tabs,
      elapsedMs: pong.elapsedMs,
    });
  } catch (err) { next(err); }
});

apiRouter.post('/sheets/pull', async (_req, res, next) => {
  try { res.json(await sheets.pull({ trigger: 'manual' })); } catch (err) { next(err); }
});

/** Send what is queued. The ordinary catch-up. */
apiRouter.post('/sheets/push', async (_req, res, next) => {
  try { res.json(await sheets.drain()); } catch (err) { next(err); }
});

/**
 * Write everything, replacing what is in the ERP-owned tabs.
 *
 * For first connection and for repair. Destructive by definition, so it is a
 * separate endpoint from the ordinary push rather than a flag on it — a
 * mistyped parameter should not be able to rewrite the order book.
 */
apiRouter.post('/sheets/push-all', async (_req, res, next) => {
  try { res.json(await sheets.pushAll({ trigger: 'manual' })); } catch (err) { next(err); }
});

/**
 * One place that turns a thrown error into an answer a screen can show.
 *
 * The status matters as much as the message. A quotation refused because the
 * sheet has not been read is a 503 — temporary, retry — and must not read to
 * the browser, or to the Gmail sweep, like a 400 saying the request was wrong.
 */
apiRouter.use((err, _req, res, _next) => {
  const status = err.status || (err.name === 'SheetNotReadyError' ? 503 : 400);
  if (status >= 500) console.error('[api]', err.message);
  res.status(status).json({ error: err.message, code: err.code || null });
});
