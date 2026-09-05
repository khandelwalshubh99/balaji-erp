/** Run one full sync and exit. Useful from cron, or to test the pipeline. */
import { runSync } from '../src/sync/engine.js';
import { ensureSimulatedTally } from '../src/tally/ensure-simulated.js';

const stop = await ensureSimulatedTally();

const r = await runSync('manual');
console.log(`sync ${r.status}${r.error ? ` — ${r.error}` : ''}`);
for (const d of r.datasets || []) {
  console.log(`  ${d.status === 'ok' ? 'ok  ' : 'FAIL'} ${d.dataset.padEnd(10)} ${String(d.records).padStart(6)} records  ${d.ms}ms${d.error ? `  ${d.error}` : ''}`);
}
stop();
process.exit(r.status === 'failed' ? 1 : 0);
