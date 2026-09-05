/** Run one full sync and exit. Useful from cron, or to test the pipeline. */
import { config, isSimulated } from '../src/config.js';
import { runSync } from '../src/sync/engine.js';

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
}

const r = await runSync('manual');
console.log(`sync ${r.status}${r.error ? ` — ${r.error}` : ''}`);
for (const d of r.datasets || []) {
  console.log(`  ${d.status === 'ok' ? 'ok  ' : 'FAIL'} ${d.dataset.padEnd(10)} ${String(d.records).padStart(6)} records  ${d.ms}ms${d.error ? `  ${d.error}` : ''}`);
}
stop();
process.exit(r.status === 'failed' ? 1 : 0);
