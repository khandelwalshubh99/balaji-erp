import path from 'node:path';
import express from 'express';
import session from 'express-session';
import { config, isSimulated } from './config.js';
import { seedUsers } from './db/index.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { requireAuth } from './middleware/auth.js';
import { runSync, startScheduler } from './sync/engine.js';
import { tally } from './tally/client.js';

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
}

boot().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
