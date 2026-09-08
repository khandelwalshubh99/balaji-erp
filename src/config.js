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
  // Overridable so a second instance, or a test run, never writes over the
  // working database.
  dbPath: process.env.DB_PATH ? path.resolve(root, process.env.DB_PATH) : path.join(root, 'data', 'balaji.db'),

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

  mail: {
    /**
     * Our own mail domains, comma separated. Anything sent FROM one of these is
     * logged against its thread but never classified and never mints a number —
     * our own quotation email contains every enquiry phrase there is, and
     * reading it as a customer enquiry would invent a record out of our reply.
     */
    ownDomains: process.env.MAIL_OWN_DOMAINS || '',

    /**
     * Individual addresses of ours that live on a shared mail provider.
     *
     * This exists because the obvious shortcut is a catastrophe. The rediffmail
     * account forwards into sales@, so rediffmail.com looks like it belongs in
     * MAIL_OWN_DOMAINS — and putting it there would mark every customer on
     * rediffmail as us. Half the buyers in Pithampur are on rediffmail, and
     * their orders would be logged, never classified, and never given a number.
     * A free-mail domain is refused there and has to be listed here instead.
     */
    ownAddresses: process.env.MAIL_OWN_ADDRESSES || '',
  },

  /**
   * The Google Sheet that holds everything Tally does not.
   *
   * Both values are usually set from the Connection screen and stored in the
   * database, because whoever runs the office should be able to repoint the ERP
   * at a new sheet without a deploy. These .env values are the fallback, and
   * the reason they exist is `npm run db:reset`: a database that has just been
   * deleted cannot tell you where to fetch itself from.
   */
  sheets: {
    webAppUrl: process.env.SHEETS_WEBAPP_URL || '',
    token: process.env.SHEETS_TOKEN || '',
    /**
     * Generous, and it has to be. Apps Script allows a single execution about
     * six minutes, and a first full push of several thousand rows will use a
     * fair share of that. Timing out early would leave the sheet half written
     * with nothing to say so.
     */
    timeoutMs: num(process.env.SHEETS_TIMEOUT_MS, 120000),
    /** Rows per call. Well under the Apps Script payload limit, with room. */
    batchRows: num(process.env.SHEETS_BATCH_ROWS, 500),
    pullOnBoot: bool(process.env.SHEETS_PULL_ON_BOOT, true),
    intervalMinutes: num(process.env.SHEETS_INTERVAL_MINUTES, 10),
  },

  rules: {
    defaultReorderLevel: num(process.env.LOW_STOCK_DEFAULT_REORDER_LEVEL, 10),
    defaultCreditPeriodDays: num(process.env.DEFAULT_CREDIT_PERIOD_DAYS, 30),
  },
};

export const isSimulated = () => config.tally.mode === 'simulated';
