/**
 * Phase 0 from the command line.
 *
 *   npm run tally:probe            -> connection check
 *   npm run tally:probe -- ledgers -> pull one dataset and show a sample
 *
 * Works against the simulated Tally or the real one, depending on .env.
 */
import { config, isSimulated } from '../src/config.js';
import { tally } from '../src/tally/client.js';

let stop = () => {};
if (isSimulated()) {
  const { startMockTally } = await import('../src/tally/mock-server.js');
  const h = await startMockTally({
    port: config.tally.port,
    seed: config.mock.seed,
    latencyMs: config.mock.latencyMs,
    company: config.tally.company,
  });
  stop = () => h.server.close();
  console.log(`(simulated TallyPrime started on port ${h.port})\n`);
}

const which = process.argv[2] || 'ping';
const t = tally.target();
console.log(`Target : ${t.url}  [${t.mode}]`);
console.log(`Company: ${t.company}\n`);

try {
  if (which === 'ping') {
    const r = await tally.ping();
    console.log(r.ok ? 'PASS' : 'FAIL', '-', r.message, `(${r.elapsedMs}ms)`);
    if (r.companies.length) console.log('Companies:', r.companies.map((c) => c.name).join(', '));
    process.exitCode = r.ok && r.companyFound ? 0 : 1;
  } else {
    const fn = { ledgers: 'ledgers', stock: 'stockItems', bills: 'billsReceivable' }[which];
    if (!fn) throw new Error(`Unknown dataset '${which}'. Try: ping | ledgers | stock | bills | daybook`);
    const r = which === 'daybook'
      ? await tally.dayBook(new Date(Date.now() - 7 * 86400000), new Date())
      : await tally[fn]();
    console.log(`${r.records.length} record(s) in ${r.elapsedMs}ms. First record:\n`);
    console.dir(r.records[0], { depth: 4 });
  }
} catch (err) {
  console.error('FAIL -', err.message);
  process.exitCode = 1;
} finally {
  stop();
}
