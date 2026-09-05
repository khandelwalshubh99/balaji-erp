import { Router } from 'express';
import { config } from '../config.js';
import * as q from '../db/queries.js';
import { runSync, syncStatus } from '../sync/engine.js';
import { tally } from '../tally/client.js';

export const apiRouter = Router();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

apiRouter.get('/overview', (_req, res) => res.json(q.overview()));

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

apiRouter.get('/orders', (req, res) => res.json(q.orderSnapshot({ days: num(req.query.days, 45) })));

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
  const probe = PROBES[key];
  if (!probe) return res.status(400).json({ error: `Unknown probe '${key}'` });
  const request = probe.build();
  try {
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
