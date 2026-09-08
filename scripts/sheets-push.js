/**
 * Write this machine's records to the sheet, once, and exit.
 *
 *   npm run sheets:push          send what is queued
 *   npm run sheets:push -- --all replace every ERP-owned tab
 *
 * `--all` is for the first connection — an ERP with months of records in it and
 * an empty sheet — and for putting a sheet back after one was damaged. It
 * REPLACES the contents of the tabs the ERP owns. It does not touch the mail
 * sweep's Order Log, Inquiry Log or Needs Review; the script refuses those
 * outright, whatever it is asked.
 */
import * as sheets from '../src/sheets/store.js';

if (!sheets.isConfigured()) {
  console.error('No Google Sheet is connected. Set it on the Connection screen, or set SHEETS_WEBAPP_URL and SHEETS_TOKEN in .env.');
  process.exit(1);
}

const all = process.argv.includes('--all');
const t = sheets.target();
console.log(`${all ? 'Replacing' : 'Updating'} ${t.sheetUrl || t.webAppUrl}`);

try {
  if (all) {
    const res = await sheets.pushAll({ trigger: 'manual' });
    for (const [tab, n] of Object.entries(res.detail)) console.log(`  ${String(n).padStart(6)}  ${tab}`);
    console.log(`\n${res.rows} row(s) written.`);
  } else {
    const pending = sheets.pendingCount();
    if (!pending) { console.log('Nothing queued.'); process.exit(0); }
    const res = await sheets.drain({ limit: 5000 });
    console.log(`\n${res.pushed} queued change(s), ${res.rows} row(s) written.`);
  }
  process.exit(0);
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
}
