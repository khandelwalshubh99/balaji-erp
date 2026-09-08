/**
 * One flag, deliberately kept in a module of its own.
 *
 * It answers: has this process successfully read the sheet since it started?
 * Quotation and order numbering asks that question, and numbering must not
 * import the sync engine to find out — a cycle between "the thing that mints
 * numbers" and "the thing that syncs the records those numbers live in" is how
 * an import order becomes load-bearing.
 *
 * WHY NUMBERING CARES.
 * Both sequences are derived by scanning the local table for the highest number
 * in the current financial year. That is correct exactly as long as the local
 * table holds every quotation and order there is. With a sheet connected it may
 * not — a colleague's machine may have raised BE/SO/2627/0044 an hour ago —
 * and minting from a database that has not caught up would issue that number a
 * second time, to a different customer. Which is discovered weeks later by
 * whoever is chasing the payment, if at all.
 *
 * So: no sheet connected, nothing changes and numbering works as it always did.
 * Sheet connected but not yet read, numbering refuses and says why. It is a
 * worse outcome than minting, and a very much better one than minting twice.
 */
let pulledAt = null;
let lastError = null;

export function markPulled() {
  pulledAt = new Date().toISOString();
  lastError = null;
}

export function markPullFailed(message) {
  lastError = message || 'unknown error';
}

export const lastPullAt = () => pulledAt;
export const lastPullError = () => lastError;
export const hasPulled = () => pulledAt !== null;

/** Thrown at the point of minting, so the message reaches the person clicking Save. */
export class SheetNotReadyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SheetNotReadyError';
    this.status = 503;
  }
}
