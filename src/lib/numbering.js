/**
 * Issuing a number that has never been issued before.
 *
 * BE/Q, BE/SO and BE/DN all work the same way: find the highest number already
 * issued this financial year and add one. This is one function rather than
 * three because of the guard in the middle of it, which is a safety property —
 * and a safety property copied into three files is a safety property that will
 * be missing from the fourth.
 */
import { db } from '../db/index.js';
import { fyTag } from './dates.js';
import { isConfigured } from '../sheets/store.js';
import { hasPulled, SheetNotReadyError } from '../sheets/state.js';

/**
 * The next number in a sequence.
 *
 * WHY THIS CAN REFUSE.
 * The highest number issued is read from the local table, which is correct
 * exactly as long as this machine knows about every record there is. With a
 * Google Sheet connected it may not — a colleague's machine may have raised
 * one an hour ago — and minting from a database that has not caught up issues
 * that number a second time, to a different customer. Which is found out weeks
 * later by whoever is chasing the payment, if at all.
 *
 * So with a sheet connected and not yet read, this refuses and says so. That
 * is a worse outcome than minting, and a very much better one than minting
 * twice. See src/sheets/state.js.
 */
export function mintNumber({ prefix, table, column, what, width = 4 }) {
  if (isConfigured() && !hasPulled()) {
    throw new SheetNotReadyError(
      `The Google Sheet has not been read yet, so the next ${what} cannot be worked out safely. Open Connection and pull, then try again.`
    );
  }
  const stem = `${prefix}/${fyTag()}/`;
  const rows = db.prepare(`SELECT DISTINCT ${column} AS n FROM ${table} WHERE ${column} LIKE ?`).all(`${stem}%`);
  const highest = rows.reduce((max, r) => {
    const n = Number(String(r.n).slice(stem.length));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);
  return `${stem}${String(highest + 1).padStart(width, '0')}`;
}
