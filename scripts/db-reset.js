/**
 * Delete the local copy. Nothing that matters is stored only here.
 *
 * Tally is untouched, and so is the Google Sheet. Between them they hold
 * everything: Tally the ledgers, stock and bills; the sheet the quotations,
 * orders, dispatches, invoices and audit trail. The next start re-syncs from
 * one and pulls from the other.
 *
 * Which makes this the honest test of the whole arrangement rather than a
 * destructive command to be nervous about. If something does not come back
 * afterwards, it was never really in the store — and that is worth finding out
 * deliberately, on a Tuesday, rather than the morning a laptop does not boot.
 */
import fs from 'node:fs';
import { config } from '../src/config.js';

for (const suffix of ['', '-wal', '-shm']) {
  const p = config.dbPath + suffix;
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log('removed', p);
  }
}
console.log('Local copy cleared. The next start re-syncs from Tally and pulls from the sheet.');
console.log('If no sheet is connected, anything not in Tally is gone — check the Connection screen first.');
