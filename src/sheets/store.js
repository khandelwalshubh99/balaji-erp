/**
 * The sheet as the store: reading it into SQLite, and writing SQLite back out.
 *
 * The claim this file has to make good on is simple and testable:
 *
 *     rm data/balaji.db && npm start
 *
 * must give you back every quotation, order, dispatch, invoice and event you
 * had. Tally supplies the ledgers, stock and bills; the sheet supplies the
 * rest; nothing of consequence lives only here. That is the whole design, and
 * `npm run sheets:verify` is the test of it.
 *
 * TWO ASYMMETRIES, BOTH ON PURPOSE
 *
 * A pull never deletes a parent record. A row missing from a spreadsheet does
 * not mean "deleted" — it means a filter is on, a read was truncated, someone
 * sorted with a range selected, or the row genuinely went. Only the first of
 * those is a deletion, and the app cannot tell them apart, so deleting orders
 * on that evidence is not a trade worth making. Deletions go through the app,
 * which queues them explicitly.
 *
 * A pull DOES delete lines. A quotation's lines are its contents rather than
 * records in their own right, so removing line 3 of five has to leave four
 * lines. The reconciliation is confined to parents that actually appear in the
 * lines tab, so an order whose lines have never been pushed keeps them.
 */
import { db } from '../db/index.js';
import { config } from '../config.js';
import { getSetting, setSetting, parseSheetId, sheetUrlFor } from '../settings/service.js';
import { call, useSettings, parseWebAppUrl, SheetRefusedError } from './client.js';
import { TABS, TAB_BY_KEY, SCRIPT_TABS, headerOf, typesOf, toRow, fromRow } from './tabs.js';
import { markPulled, markPullFailed, lastPullAt, lastPullError, hasPulled } from './state.js';

// The client reads its target through this, so a saved connection and one
// being tested in an unsaved form field go down the identical code path.
useSettings(() => ({ url: connection().webAppUrl, token: connection().token }));

// --- Connection -------------------------------------------------------------

/**
 * Where the sheet is, and how to prove we may write to it.
 *
 * Settings first, .env second. The order matters after `npm run db:reset`: the
 * settings table has just been deleted along with everything else, and the
 * environment is the only thing left that can say where to fetch it all back
 * from. Without that fallback the rebuild is a chicken-and-egg problem.
 */
export function connection() {
  return {
    webAppUrl: getSetting('sheets.webAppUrl') || config.sheets.webAppUrl || '',
    token: getSetting('sheets.token') || config.sheets.token || '',
    sheetId: getSetting('sheets.sheetId') || getSetting('mail.sheetId') || '',
  };
}

export const isConfigured = () => Boolean(connection().webAppUrl);

export function saveConnection({ webAppUrl, token, sheetId }, actor = null) {
  if (webAppUrl !== undefined) {
    const { url, error } = parseWebAppUrl(webAppUrl);
    if (webAppUrl && error) throw new SheetRefusedError(error, 'bad-url');
    setSetting('sheets.webAppUrl', url, actor);
  }
  // An empty string means "leave it alone" rather than "clear it", so the form
  // can show a masked token without the act of saving wiping it.
  if (token) setSetting('sheets.token', String(token).trim(), actor);
  if (sheetId !== undefined) {
    const id = parseSheetId(sheetId);
    if (sheetId && !id) throw new SheetRefusedError('That is not a Google Sheets link or id.', 'bad-sheet-id');
    setSetting('sheets.sheetId', id, actor);
    // Kept in step with the value the mail screen has always shown, so the two
    // screens cannot disagree about which sheet this is.
    setSetting('mail.sheetId', id, actor);
  }
  setSetting('sheets.updatedAt', new Date().toISOString(), actor);
  return target();
}

export function target() {
  const c = connection();
  return {
    configured: Boolean(c.webAppUrl),
    webAppUrl: c.webAppUrl,
    tokenSet: Boolean(c.token),
    sheetId: c.sheetId || null,
    sheetUrl: sheetUrlFor(c.sheetId),
    pullOnBoot: config.sheets.pullOnBoot,
    intervalMinutes: config.sheets.intervalMinutes,
    lastPullAt: lastPullAt(),
    lastPullError: lastPullError(),
    readyToMint: !isConfigured() || hasPulled(),
    ownTabs: TABS.map((t) => ({ tab: t.tab, label: t.label })),
    scriptTabs: SCRIPT_TABS,
  };
}

/** Does the script answer, is the token right, and is it the sheet we think it is. */
export async function ping(override = {}) {
  const res = await call('ping', {}, {
    url: override.webAppUrl || undefined,
    token: override.token !== undefined && override.token !== '' ? override.token : undefined,
  });
  return res;
}

// --- The outbox -------------------------------------------------------------

/**
 * Note that a record has changed. Never throws, and that is the contract.
 *
 * Called from inside the transaction that saved a quotation. If it could fail,
 * the sheet being unreachable would roll back a quotation someone is saving in
 * front of a customer — trading a real, immediate loss for a sync that would
 * have caught up on its own within the minute.
 */
export function queue(entity, entityId, op = 'upsert') {
  if (!isConfigured()) return;
  try {
    db.prepare(`
      INSERT INTO sheet_outbox (entity, entity_id, op, queued_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(entity, entity_id) DO UPDATE SET
        op = excluded.op, queued_at = excluded.queued_at, attempts = 0, last_error = NULL`)
      .run(entity, entityId, op, new Date().toISOString());
  } catch (err) {
    console.error('[sheets] could not queue', entity, entityId, err.message);
  }
}

/** Queue a parent and everything hanging off it, which is what a save actually changed. */
export function queueOrder(orderId) {
  queue('orders', orderId);
  queue('order_lines', orderId);      // keyed on the parent: lines go as a set
}

export function queueQuotation(quotationId) {
  queue('quotations', quotationId);
  queue('quotation_lines', quotationId);
}

export function queueDispatch(dispatchId) {
  queue('dispatches', dispatchId);
  queue('dispatch_lines', dispatchId);
}

export const pendingCount = () =>
  db.prepare('SELECT COUNT(*) AS n FROM sheet_outbox').get().n;

// --- Push -------------------------------------------------------------------

const nonDerived = (spec) => spec.columns.filter((c) => c[1]);

/** Lookups for the columns that exist only so a human can read the tab. */
function contextFor(specs) {
  const ctx = {};
  if (specs.some((s) => s.columns.some((c) => c[0] === 'Quote Number' && !c[1]))) {
    ctx.quotations = new Map(
      db.prepare('SELECT id, quote_number FROM quotations').all().map((r) => [r.id, r])
    );
  }
  if (specs.some((s) => s.columns.some((c) => c[0] === 'Order Number' && !c[1]))) {
    ctx.orders = new Map(
      db.prepare('SELECT id, order_number FROM orders').all().map((r) => [r.id, r])
    );
  }
  return ctx;
}

function writeSpec(spec, rows, ctx, extra = {}) {
  return {
    tab: spec.tab,
    header: headerOf(spec),
    types: typesOf(spec),
    key: 'ID',
    rows: rows.map((r) => toRow(spec, r, ctx)),
    ...extra,
  };
}

/**
 * Send the queued changes.
 *
 * Everything queued goes in one call where it fits, because a push that takes
 * eight round trips is eight chances to be halfway done when the wifi drops.
 */
export async function drain({ limit = 200 } = {}) {
  if (!isConfigured()) return { skipped: 'not-configured' };
  const queued = db.prepare('SELECT * FROM sheet_outbox ORDER BY queued_at LIMIT ?').all(limit);
  if (!queued.length) return { pushed: 0, rows: 0 };

  const started = Date.now();
  const byEntity = new Map();
  for (const row of queued) {
    if (!byEntity.has(row.entity)) byEntity.set(row.entity, []);
    byEntity.get(row.entity).push(row);
  }

  const writes = [];
  const ctx = contextFor(TABS);
  for (const spec of TABS) {                       // dependency order, always
    const jobs = byEntity.get(spec.key);
    if (!jobs) continue;
    const ids = jobs.filter((j) => j.op === 'upsert').map((j) => j.entity_id);
    const gone = jobs.filter((j) => j.op === 'delete').map((j) => j.entity_id);

    if (spec.parent) {
      // The queued id is the PARENT's. Lines are replaced as a set, so the
      // script is told which parents to clear before the new rows land.
      const rows = ids.length
        ? db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.parent} IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids)
        : [];
      const parentColumn = spec.columns.find((c) => c[1] === spec.parent)[0];
      writes.push(writeSpec(spec, rows, ctx, {
        mode: 'replace-children',
        parentColumn,
        parentValues: [...ids, ...gone],
      }));
    } else {
      const rows = ids.length
        ? db.prepare(`SELECT * FROM ${spec.table} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
        : [];
      writes.push(writeSpec(spec, rows, ctx, {
        mode: spec.appendOnly ? 'append-missing' : 'upsert',
        remove: gone,
      }));
    }
  }

  const started_at = new Date().toISOString();
  try {
    const res = await call('batch', { writes });
    const ids = queued.map((q) => q.id);
    db.prepare(`DELETE FROM sheet_outbox WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    const rows = writes.reduce((n, w) => n + w.rows.length, 0);
    record('push', 'write', 'ok', { rowsOut: rows, detail: res.written || null, started_at, ms: Date.now() - started });
    return { pushed: queued.length, rows, detail: res.written || null };
  } catch (err) {
    const ids = queued.map((q) => q.id);
    db.prepare(`UPDATE sheet_outbox SET attempts = attempts + 1, last_error = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(err.message, ...ids);
    record('push', 'write', 'failed', { error: err.message, started_at, ms: Date.now() - started });
    throw err;
  }
}

/**
 * Write every mirrored row, replacing what is in the sheet.
 *
 * For first connection, and for putting a sheet back after one was damaged. It
 * is destructive to the ERP-owned tabs by design — that is what "replace"
 * means — and touches none of the script's mail log.
 */
export async function pushAll({ trigger = 'manual' } = {}) {
  if (!isConfigured()) throw new SheetRefusedError('No Google Sheet is connected.', 'not-configured');
  const started = Date.now();
  const started_at = new Date().toISOString();
  const ctx = contextFor(TABS);
  const detail = {};
  let rowsOut = 0;

  try {
    for (const spec of TABS) {
      const all = db.prepare(`SELECT * FROM ${spec.table} ORDER BY id`).all();
      detail[spec.tab] = all.length;
      rowsOut += all.length;
      // Chunked because one call carrying twelve thousand rows is a payload
      // Apps Script will refuse, and the refusal arrives as a truncated write.
      const size = config.sheets.batchRows;
      if (!all.length) {
        await call('batch', { writes: [writeSpec(spec, [], ctx, { mode: 'replace' })] });
        continue;
      }
      for (let i = 0; i < all.length; i += size) {
        await call('batch', {
          writes: [writeSpec(spec, all.slice(i, i + size), ctx, { mode: i === 0 ? 'replace' : 'append' })],
        });
      }
    }
    db.prepare('DELETE FROM sheet_outbox').run();
    record('push', trigger, 'ok', { rowsOut, detail, started_at, ms: Date.now() - started });
    return { rows: rowsOut, detail };
  } catch (err) {
    record('push', trigger, 'failed', { rowsOut, detail, error: err.message, started_at, ms: Date.now() - started });
    throw err;
  }
}

// --- Pull -------------------------------------------------------------------

/**
 * Read the sheet and reconcile it into SQLite.
 *
 * Runs on boot before the first request is served, so a machine that has never
 * seen this data is up to date by the time anyone can look at a screen. Runs
 * again on a timer, which is what makes two machines on the same sheet
 * eventually agree.
 */
export async function pull({ trigger = 'manual' } = {}) {
  if (!isConfigured()) return { skipped: 'not-configured' };
  const started = Date.now();
  const started_at = new Date().toISOString();
  const detail = {};
  const problems = [];
  let rowsIn = 0;

  try {
    const res = await call('read', { tabs: TABS.map((t) => t.tab) });
    const apply = db.transaction(() => {
      for (const spec of TABS) {
        const sheet = res.sheets?.[spec.tab];
        // A tab that does not exist yet is not an error — it is a sheet that
        // has never been pushed to. An empty one is not an instruction to
        // empty the table either, for the same reason.
        if (!sheet || !sheet.header?.length) { detail[spec.tab] = 0; continue; }
        const outcome = reconcile(spec, sheet.header, sheet.rows || []);
        detail[spec.tab] = outcome.applied;
        rowsIn += outcome.applied;
        if (outcome.bad.length) problems.push(`${spec.tab}: ${outcome.bad.length} row(s) with no usable ID`);
      }
    });
    apply();

    markPulled();
    record('pull', trigger, problems.length ? 'partial' : 'ok', {
      rowsIn, detail, error: problems.join('; ') || null, started_at, ms: Date.now() - started,
    });
    return { rows: rowsIn, detail, problems };
  } catch (err) {
    markPullFailed(err.message);
    record('pull', trigger, 'failed', { detail, error: err.message, started_at, ms: Date.now() - started });
    throw err;
  }
}

function reconcile(spec, header, rows) {
  const columns = nonDerived(spec).map((c) => c[1]);
  const placeholders = columns.map(() => '?').join(',');
  const updates = columns.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');

  const upsert = db.prepare(
    spec.appendOnly
      // An event already written is never rewritten from a spreadsheet. See
      // `appendOnly` in tabs.js: an edited audit trail is not an audit trail.
      ? `INSERT OR IGNORE INTO ${spec.table} (${columns.join(',')}) VALUES (${placeholders})`
      : `INSERT INTO ${spec.table} (${columns.join(',')}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${updates}`
  );

  const bad = [];
  const seenChildren = new Map();   // parent id -> Set of child ids present
  let applied = 0;

  for (const cells of rows) {
    const values = fromRow(spec, header, cells);
    if (!Number.isFinite(values.id)) { bad.push(cells); continue; }
    if (spec.parent) {
      const parentId = values[spec.parent];
      if (!Number.isFinite(parentId)) { bad.push(cells); continue; }
      if (!seenChildren.has(parentId)) seenChildren.set(parentId, new Set());
      seenChildren.get(parentId).add(values.id);
    }
    try {
      upsert.run(...columns.map((c) => values[c]));
      applied += 1;
    } catch (err) {
      // A foreign key pointing at a parent that is not in the sheet either.
      // Recorded and skipped: one orphan line must not abandon the pull.
      bad.push(cells);
    }
  }

  // Lines removed in the sheet are removed here, but only for parents the
  // sheet actually spoke about. See the file header.
  if (spec.parent) {
    const remove = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.parent} = ? AND id NOT IN (SELECT value FROM json_each(?))`);
    for (const [parentId, keep] of seenChildren) {
      remove.run(parentId, JSON.stringify([...keep]));
    }
  }

  return { applied, bad };
}

// --- Bookkeeping ------------------------------------------------------------

function record(direction, trigger, status, { rowsIn = 0, rowsOut = 0, detail = null, error = null, started_at, ms = 0 } = {}) {
  db.prepare(`
    INSERT INTO sheet_runs (direction, trigger, status, rows_in, rows_out, detail, error, started_at, finished_at, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(direction, trigger, status, rowsIn, rowsOut, detail ? JSON.stringify(detail) : null, error,
      started_at, new Date().toISOString(), ms);
}

export function status() {
  const last = (direction) => {
    const row = db.prepare('SELECT * FROM sheet_runs WHERE direction = ? ORDER BY id DESC LIMIT 1').get(direction);
    return row ? { ...row, detail: row.detail ? JSON.parse(row.detail) : null } : null;
  };
  const counts = Object.fromEntries(
    TABS.map((t) => [t.tab, db.prepare(`SELECT COUNT(*) AS n FROM ${t.table}`).get().n])
  );
  return {
    ...target(),
    lastPull: last('pull'),
    lastPush: last('push'),
    pending: pendingCount(),
    oldestPending: db.prepare('SELECT queued_at FROM sheet_outbox ORDER BY queued_at LIMIT 1').get()?.queued_at || null,
    failing: db.prepare('SELECT entity, entity_id, attempts, last_error FROM sheet_outbox WHERE attempts > 0 ORDER BY attempts DESC LIMIT 5').all(),
    counts,
  };
}

// --- Scheduling -------------------------------------------------------------

let timer = null;

/**
 * One timer for both directions, pulling then pushing.
 *
 * That order is not arbitrary. Pushing first would write this machine's view
 * over a change another machine made two minutes ago; pulling first means the
 * push carries the merged state. It does not make concurrent edits safe — two
 * people editing one order still means the later save wins — but it stops the
 * sync itself from being the thing that loses work.
 */
export function startScheduler() {
  if (timer || !config.sheets.intervalMinutes) return;
  const every = config.sheets.intervalMinutes * 60 * 1000;
  timer = setInterval(() => {
    if (!isConfigured()) return;
    pull({ trigger: 'scheduled' })
      .catch((e) => console.error('[sheets] scheduled pull failed:', e.message))
      .then(() => drain())
      .catch((e) => console.error('[sheets] scheduled push failed:', e.message));
  }, every);
  timer.unref?.();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
