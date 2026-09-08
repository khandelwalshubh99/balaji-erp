/**
 * Phase 1 sync engine.
 *
 * Pulls the five Tally datasets on a timer into the local store. Each dataset
 * is written in its own transaction, so one bad dataset does not poison the
 * rest — the run is marked `partial` and the dashboard says so, rather than
 * quietly showing stale numbers as if they were fresh.
 *
 * Direction is strictly Tally -> here. Nothing is written back to Tally until
 * Phase 3, and that is deliberate.
 */
import { db } from '../db/index.js';
import { config } from '../config.js';
import { tally } from '../tally/client.js';
import { matchCatalogue } from '../catalogue/match.js';
import { matchAll as matchInvoices } from '../invoices/service.js';

const now = () => new Date().toISOString();

let running = false;
let timer = null;
let lastResult = null;

// --- writers ---------------------------------------------------------------
const writers = {
  ledgers: {
    label: 'Ledgers & parties',
    fetch: () => tally.ledgers(),
    write(rows, stamp) {
      const insert = db.prepare(`
        INSERT INTO tally_ledgers (guid, name, parent, is_customer, is_supplier, phone, gstin, state,
          credit_period_days, credit_limit, opening_balance, closing_balance, outstanding, synced_at)
        VALUES (@guid, @name, @parent, @is_customer, @is_supplier, @phone, @gstin, @state,
          @credit_period_days, @credit_limit, @opening_balance, @closing_balance, @outstanding, @synced_at)
        ON CONFLICT(guid) DO UPDATE SET
          name=excluded.name, parent=excluded.parent, is_customer=excluded.is_customer,
          is_supplier=excluded.is_supplier, phone=excluded.phone, gstin=excluded.gstin,
          state=excluded.state, credit_period_days=excluded.credit_period_days,
          credit_limit=excluded.credit_limit, opening_balance=excluded.opening_balance,
          closing_balance=excluded.closing_balance, outstanding=excluded.outstanding,
          synced_at=excluded.synced_at`);
      for (const r of rows) {
        insert.run({
          guid: r.guid, name: r.name, parent: r.parent,
          is_customer: r.isCustomer ? 1 : 0, is_supplier: r.isSupplier ? 1 : 0,
          phone: r.phone, gstin: r.gstin, state: r.state,
          credit_period_days: r.creditPeriodDays, credit_limit: r.creditLimit,
          opening_balance: r.openingBalance, closing_balance: r.closingBalance,
          outstanding: r.outstanding, synced_at: stamp,
        });
      }
      db.prepare('DELETE FROM tally_ledgers WHERE synced_at < ?').run(stamp);
    },
  },

  stock: {
    label: 'Stock items',
    fetch: () => tally.stockItems(),
    write(rows, stamp) {
      const insert = db.prepare(`
        INSERT INTO tally_stock_items (guid, name, alias, part_number, category, item_group, base_units,
          hsn, gst_rate, reorder_level, standard_price, closing_qty, closing_rate, closing_value, synced_at)
        VALUES (@guid, @name, @alias, @part_number, @category, @item_group, @base_units,
          @hsn, @gst_rate, @reorder_level, @standard_price, @closing_qty, @closing_rate, @closing_value, @synced_at)
        ON CONFLICT(guid) DO UPDATE SET
          name=excluded.name, alias=excluded.alias, part_number=excluded.part_number,
          category=excluded.category, item_group=excluded.item_group, base_units=excluded.base_units,
          hsn=excluded.hsn, gst_rate=excluded.gst_rate, reorder_level=excluded.reorder_level,
          standard_price=excluded.standard_price, closing_qty=excluded.closing_qty,
          closing_rate=excluded.closing_rate, closing_value=excluded.closing_value,
          synced_at=excluded.synced_at`);
      for (const r of rows) {
        insert.run({
          guid: r.guid, name: r.name, alias: r.alias, part_number: r.partNumber,
          category: r.category, item_group: r.group, base_units: r.baseUnits,
          hsn: r.hsn, gst_rate: r.gstRate, reorder_level: r.reorderLevel,
          standard_price: r.standardPrice, closing_qty: r.closingQty,
          closing_rate: r.closingRate, closing_value: r.closingValue, synced_at: stamp,
        });
      }
      db.prepare('DELETE FROM tally_stock_items WHERE synced_at < ?').run(stamp);
    },
  },

  bills: {
    label: 'Outstanding bills',
    fetch: () => tally.billsReceivable(),
    write(rows, stamp) {
      // Bills close out entirely when paid, so this set is replaced wholesale.
      db.prepare('DELETE FROM tally_bills').run();
      const insert = db.prepare(`
        INSERT INTO tally_bills (bill_ref, party_name, bill_date, due_date, credit_period_days,
          opening_amount, amount, synced_at)
        VALUES (@bill_ref, @party_name, @bill_date, @due_date, @credit_period_days,
          @opening_amount, @amount, @synced_at)
        ON CONFLICT(bill_ref, party_name) DO UPDATE SET amount=excluded.amount, synced_at=excluded.synced_at`);
      for (const r of rows) {
        insert.run({
          bill_ref: r.billRef, party_name: r.partyName, bill_date: r.billDate,
          due_date: r.dueDate, credit_period_days: r.creditPeriodDays,
          opening_amount: r.openingAmount, amount: r.amount, synced_at: stamp,
        });
      }
    },
  },

  vouchers: {
    label: 'Vouchers (last 120 days)',
    fetch: () => {
      const to = new Date();
      const from = new Date(to.getTime() - 120 * 86400000);
      return tally.dayBook(from, to);
    },
    write(rows, stamp) {
      const insert = db.prepare(`
        INSERT INTO tally_vouchers (guid, voucher_type, voucher_number, date, party_name,
          reference, narration, amount, line_count, synced_at)
        VALUES (@guid, @voucher_type, @voucher_number, @date, @party_name,
          @reference, @narration, @amount, @line_count, @synced_at)
        ON CONFLICT(guid) DO UPDATE SET
          voucher_type=excluded.voucher_type, voucher_number=excluded.voucher_number,
          date=excluded.date, party_name=excluded.party_name, reference=excluded.reference,
          narration=excluded.narration, amount=excluded.amount, line_count=excluded.line_count,
          synced_at=excluded.synced_at`);
      const clearLines = db.prepare('DELETE FROM tally_voucher_lines WHERE voucher_guid = ?');
      const insertLine = db.prepare(`
        INSERT INTO tally_voucher_lines (voucher_guid, item_name, qty, units, rate, amount)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (const r of rows) {
        insert.run({
          guid: r.guid, voucher_type: r.voucherType, voucher_number: r.voucherNumber,
          date: r.date, party_name: r.partyName, reference: r.reference,
          narration: r.narration, amount: r.amount, line_count: r.lines.length, synced_at: stamp,
        });
        clearLines.run(r.guid);
        for (const li of r.lines) insertLine.run(r.guid, li.itemName, li.qty, li.units, li.rate, li.amount);
      }
      db.prepare('DELETE FROM tally_vouchers WHERE synced_at < ?').run(stamp);
    },
  },
};

// --- run -------------------------------------------------------------------
export async function runSync(trigger = 'manual') {
  if (running) return { skipped: true, reason: 'A sync is already running' };
  running = true;

  const target = tally.target();
  const startedAt = now();
  const t0 = Date.now();
  const run = db
    .prepare(
      `INSERT INTO sync_runs (started_at, status, trigger, mode, target) VALUES (?, 'running', ?, ?, ?)`
    )
    .run(startedAt, trigger, target.mode, target.url);
  const runId = run.lastInsertRowid;

  const recordDataset = db.prepare(
    `INSERT INTO sync_datasets (run_id, dataset, status, records, duration_ms, message) VALUES (?, ?, ?, ?, ?, ?)`
  );

  const results = [];
  let failures = 0;

  // Before pulling anything, confirm Tally is actually there and the right
  // company is loaded. Failing here is much cheaper than failing halfway.
  const ping = await tally.ping();
  if (!ping.ok) {
    db.prepare(`UPDATE sync_runs SET finished_at=?, status='failed', duration_ms=?, error=? WHERE id=?`)
      .run(now(), Date.now() - t0, ping.message, runId);
    recordDataset.run(runId, 'connection', 'failed', 0, ping.elapsedMs, ping.message);
    running = false;
    lastResult = { runId, status: 'failed', error: ping.message, datasets: [] };
    return lastResult;
  }

  for (const [key, writer] of Object.entries(writers)) {
    const d0 = Date.now();
    try {
      const { records } = await writer.fetch();
      const stamp = now();
      db.transaction(() => writer.write(records, stamp))();
      const ms = Date.now() - d0;
      recordDataset.run(runId, key, 'ok', records.length, ms, null);
      results.push({ dataset: key, label: writer.label, status: 'ok', records: records.length, ms });
    } catch (err) {
      failures += 1;
      const ms = Date.now() - d0;
      recordDataset.run(runId, key, 'failed', 0, ms, err.message);
      results.push({ dataset: key, label: writer.label, status: 'failed', records: 0, ms, error: err.message });
    }
  }

  // Stock items may have been renamed or added in Tally, so re-match the
  // catalogue against what just arrived. Cheap, and it keeps the quotation
  // screen from showing a stock figure that belongs to a since-renamed item.
  const stockOk = results.find((r) => r.dataset === 'stock')?.status === 'ok';
  if (stockOk) {
    const d0 = Date.now();
    try {
      const m = matchCatalogue();
      recordDataset.run(runId, 'catalogue-match', 'ok', m.matched, Date.now() - d0,
        `${m.matched} of ${m.catalogueItems} matched, ${m.unmatched} not stocked`);
      results.push({ dataset: 'catalogue-match', label: 'Catalogue match', status: 'ok', records: m.matched, ms: Date.now() - d0 });
    } catch (err) {
      recordDataset.run(runId, 'catalogue-match', 'failed', 0, Date.now() - d0, err.message);
      results.push({ dataset: 'catalogue-match', label: 'Catalogue match', status: 'failed', records: 0, ms: Date.now() - d0, error: err.message });
    }
  }

  // Bills have just changed, so invoices that could not be matched before may
  // match now — an invoice raised this morning is unmatched until the sync that
  // brings its bill in. Only the unmatched are reconsidered; see matchAll().
  const billsOk = results.find((r) => r.dataset === 'bills')?.status === 'ok';
  if (billsOk) {
    const d0 = Date.now();
    try {
      const m = matchInvoices();
      recordDataset.run(runId, 'invoice-match', 'ok', m.matched, Date.now() - d0,
        `${m.matched} of ${m.considered} unmatched invoices found their bill`);
      results.push({ dataset: 'invoice-match', label: 'Invoice match', status: 'ok', records: m.matched, ms: Date.now() - d0 });
    } catch (err) {
      recordDataset.run(runId, 'invoice-match', 'failed', 0, Date.now() - d0, err.message);
      results.push({ dataset: 'invoice-match', label: 'Invoice match', status: 'failed', records: 0, ms: Date.now() - d0, error: err.message });
    }
  }

  const status = failures === 0 ? 'ok' : failures === Object.keys(writers).length ? 'failed' : 'partial';
  db.prepare(`UPDATE sync_runs SET finished_at=?, status=?, duration_ms=?, error=? WHERE id=?`).run(
    now(),
    status,
    Date.now() - t0,
    failures ? results.filter((r) => r.error).map((r) => `${r.dataset}: ${r.error}`).join(' | ') : null,
    runId
  );

  running = false;
  lastResult = { runId, status, datasets: results, durationMs: Date.now() - t0 };
  return lastResult;
}

export function startScheduler() {
  const minutes = Math.max(1, config.sync.intervalMinutes);
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runSync('schedule').catch((e) => console.error('[sync] scheduled run failed:', e.message));
  }, minutes * 60000);
  timer.unref?.();
  return minutes;
}

export const syncStatus = () => ({ running, lastResult });
