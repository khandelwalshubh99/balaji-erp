import { config, isSimulated } from '../config.js';

/**
 * Make sure something is answering on the Tally port before a script runs.
 *
 * If the dashboard is already up it is hosting the simulated Tally, so binding
 * the port again would fail with EADDRINUSE. In that case just use the one
 * that is already there.
 *
 * Returns a stop() to call when the script is done.
 */
export async function ensureSimulatedTally() {
  if (!isSimulated()) return () => {};
  const { startMockTally } = await import('./mock-server.js');
  try {
    const handle = await startMockTally({
      port: config.tally.port,
      seed: config.mock.seed,
      failureRate: config.mock.failureRate,
      latencyMs: config.mock.latencyMs,
      company: config.tally.company,
    });
    return () => handle.server.close();
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    console.log(`(using the simulated Tally already running on port ${config.tally.port})\n`);
    return () => {};
  }
}
