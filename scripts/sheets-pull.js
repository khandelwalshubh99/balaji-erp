/**
 * Read the sheet into this machine's database, once, and exit.
 *
 *   npm run sheets:pull
 *
 * The app does this on boot and on a timer, so this exists for the times you
 * want it to have happened now: after someone else has raised an order, after
 * correcting a row by hand, or as the second half of `npm run db:reset` when
 * you are rebuilding a machine from the sheet.
 */
import * as sheets from '../src/sheets/store.js';

if (!sheets.isConfigured()) {
  console.error('No Google Sheet is connected. Set it on the Connection screen, or set SHEETS_WEBAPP_URL and SHEETS_TOKEN in .env.');
  process.exit(1);
}

const t = sheets.target();
console.log(`Reading ${t.sheetUrl || t.webAppUrl}`);
try {
  const res = await sheets.pull({ trigger: 'manual' });
  for (const [tab, n] of Object.entries(res.detail)) console.log(`  ${String(n).padStart(6)}  ${tab}`);
  console.log(`\n${res.rows} row(s) in.`);
  for (const p of res.problems) console.log(`  warning: ${p}`);
  process.exit(0);
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
}
