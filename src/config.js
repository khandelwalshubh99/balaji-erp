import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (v, fallback) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));

export const config = {
  root,
  port: num(process.env.PORT, 4000),
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  dbPath: path.join(root, 'data', 'balaji.db'),

  tally: {
    /** 'simulated' | 'live' */
    mode: (process.env.TALLY_MODE || 'simulated').toLowerCase(),
    host: process.env.TALLY_HOST || '127.0.0.1',
    port: num(process.env.TALLY_PORT, 9000),
    company: process.env.TALLY_COMPANY || 'Balaji Enterprises',
    timeoutMs: num(process.env.TALLY_TIMEOUT_MS, 20000),
  },

  mock: {
    seed: process.env.MOCK_SEED || 'balaji-2026',
    failureRate: num(process.env.MOCK_FAILURE_RATE, 0),
    latencyMs: num(process.env.MOCK_LATENCY_MS, 120),
  },

  sync: {
    intervalMinutes: num(process.env.SYNC_INTERVAL_MINUTES, 20),
    onBoot: bool(process.env.SYNC_ON_BOOT, true),
  },

  /**
   * Shared secret for the purchase-order ingest endpoint. Unset means the
   * endpoint is off — it fails closed, because an open endpoint that creates
   * orders is worse than no endpoint.
   */
  ingestToken: process.env.INGEST_TOKEN || '',

  rules: {
    defaultReorderLevel: num(process.env.LOW_STOCK_DEFAULT_REORDER_LEVEL, 10),
    defaultCreditPeriodDays: num(process.env.DEFAULT_CREDIT_PERIOD_DAYS, 30),
  },
};

export const isSimulated = () => config.tally.mode === 'simulated';
