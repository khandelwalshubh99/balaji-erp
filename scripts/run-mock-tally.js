/** Run the simulated TallyPrime on its own, e.g. to point another tool at it. */
import { config } from '../src/config.js';
import { startMockTally } from '../src/tally/mock-server.js';

const { port, company } = await startMockTally({
  port: config.tally.port,
  seed: config.mock.seed,
  failureRate: config.mock.failureRate,
  latencyMs: config.mock.latencyMs,
  company: config.tally.company,
  log: (m) => console.log(`[mock-tally] ${m}`),
});
console.log(`Simulated TallyPrime listening on http://127.0.0.1:${port} — company "${company.companyName}"`);
