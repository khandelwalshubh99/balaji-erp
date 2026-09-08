import path from 'node:path';
import express from 'express';
import session from 'express-session';
import { config, isSimulated } from './config.js';
import { seedUsers } from './db/index.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { ingestRouter } from './routes/ingest.js';
import { requireAuth } from './middleware/auth.js';
import { runSync, startScheduler } from './sync/engine.js';
import { tally } from './tally/client.js';
import * as sheets from './sheets/store.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    name: 'balaji.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 },
  })
);

const publicDir = path.join(config.root, 'public');

app.use(authRouter);
// Mounted before requireAuth: this one carries its own shared-secret check
// because Apps Script cannot hold a session.
app.use(ingestRouter);
app.get('/login', (_req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.use('/assets', express.static(path.join(publicDir, 'assets')));
app.use('/css', express.static(path.join(publicDir, 'css')));
app.use('/js', express.static(path.join(publicDir, 'js')));

app.use('/api', requireAuth, apiRouter);
app.get('/healthz', (_req, res) => res.json({ ok: true, mode: config.tally.mode }));

// Everything else is the single-page shell, behind the login.
app.get('*', requireAuth, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

async function boot() {
  const created = seedUsers();

  // The store is read BEFORE the port is opened, and awaited.
  //
  // Not for tidiness. Quotation and order numbers are worked out by looking at
  // the highest one already issued, so serving a screen that can mint a number
  // before this machine knows what the sheet holds is how BE/SO/2627/0044 gets
  // issued to two customers. Numbering refuses until this has run, which means
  // a boot that reaches the sheet is the difference between a working app and
  // one that can read but not raise anything.
  //
  // A failure here is survivable and deliberately not fatal: everything Tally
  // supplies still works, the Connection screen says what went wrong, and
  // Retry is one click. Refusing to start would turn a flaky wifi connection
  // into an office that cannot look anything up.
  let sheetBoot = null;
  if (sheets.isConfigured() && config.sheets.pullOnBoot) {
    try {
      sheetBoot = await sheets.pull({ trigger: 'boot' });
      console.log(`[sheets] boot pull: ${sheetBoot.rows} row(s) in` +
        (sheetBoot.problems?.length ? ` — ${sheetBoot.problems.join('; ')}` : ''));
    } catch (err) {
      console.error(`[sheets] boot pull FAILED: ${err.message}`);
      console.error('[sheets] Tally data is unaffected. New quotation and order numbers are held back until the sheet has been read.');
    }
  }

  let mockHandle = null;
  if (isSimulated()) {
    const { startMockTally } = await import('./tally/mock-server.js');
    mockHandle = await startMockTally({
      port: config.tally.port,
      seed: config.mock.seed,
      failureRate: config.mock.failureRate,
      latencyMs: config.mock.latencyMs,
      company: config.tally.company,
    });
    // Point the client at where the simulation actually landed. If the wanted
    // port was taken it moved, and leaving the client on the original would
    // have it talking to whatever else is listening there — most likely
    // another instance's fake Tally, which answers plausibly and is not ours.
    config.tally.port = mockHandle.port;
  }

  app.listen(config.port, () => {
    const t = tally.target();
    console.log('');
    console.log('  Balaji Enterprises ERP  ·  Phase 0 + Phase 1');
    console.log(`  Dashboard    http://localhost:${config.port}`);
    console.log(
      `  Tally        ${t.url}  [${t.mode}${mockHandle ? ' — simulated TallyPrime running in-process' : ''}]`
    );
    console.log(`  Company      ${t.company}`);
    console.log(`  Sync         every ${config.sync.intervalMinutes} min`);
    const store = sheets.target();
    console.log(
      `  Store        ${store.configured
        ? `Google Sheet  [${store.readyToMint ? `read, ${sheetBoot?.rows ?? 0} rows` : 'NOT READ — numbering held'}]`
        : 'local only — no Google Sheet connected'}`
    );
    if (created.length) {
      console.log('');
      console.log('  Seeded logins (change the passwords):');
      for (const c of created) console.log(`    ${c.username} / ${c.password}`);
    }
    console.log('');
  });

  if (config.sync.onBoot) {
    runSync('boot')
      .then((r) => console.log(`[sync] boot run ${r.status}`, r.datasets?.map((d) => `${d.dataset}:${d.records}`).join(' ') || r.error || ''))
      .catch((e) => console.error('[sync] boot run failed:', e.message));
  }
  startScheduler();

  // Anything queued while the app was closed goes out now, before the timer's
  // first tick — the common case being a laptop that was shut with unsent work
  // on it.
  if (sheets.isConfigured()) {
    sheets.drain().catch((e) => console.error('[sheets] catch-up push failed:', e.message));
    sheets.startScheduler();
  }
}

boot().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
