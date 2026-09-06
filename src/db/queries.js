/**
 * Read models for the Phase 1 dashboard.
 *
 * All of these read the synced copy, never Tally. If a number here looks wrong,
 * the question is "did the sync work?" (Tally Connection page) before it is
 * "is the query wrong?".
 */
import { db } from './index.js';
import { config } from '../config.js';

const AGEING_BUCKETS = [
  { key: '0-30', label: '0-30 days', min: 0, max: 30 },
  { key: '31-60', label: '31-60 days', min: 31, max: 60 },
  { key: '61-90', label: '61-90 days', min: 61, max: 90 },
  { key: '90+', label: 'Over 90 days', min: 91, max: Infinity },
];

/**
 * Whole-day difference, timezone-safe.
 *
 * Everything from Tally is a plain YYYY-MM-DD with no time and no zone. Doing
 * arithmetic against `new Date()` mixes a UTC-midnight date with a local
 * instant and drifts by a day either side of midnight, so both sides are
 * reduced to a day number first.
 */
const dayNumber = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};
const todayNumber = () => {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / 86400000;
};
const daysSince = (iso) => todayNumber() - dayNumber(iso);
const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const isoDaysAgo = (n) => new Date((todayNumber() - n) * 86400000).toISOString().slice(0, 10);

export function lastSync() {
  const run = db
    .prepare(`SELECT * FROM sync_runs WHERE status != 'running' ORDER BY id DESC LIMIT 1`)
    .get();
  if (!run) return null;
  const datasets = db.prepare('SELECT * FROM sync_datasets WHERE run_id = ? ORDER BY id').all(run.id);
  return { ...run, datasets };
}

export function syncHistory(limit = 25) {
  const runs = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?').all(limit);
  const byRun = db.prepare('SELECT * FROM sync_datasets WHERE run_id = ? ORDER BY id');
  return runs.map((r) => ({ ...r, datasets: byRun.all(r.id) }));
}

// --- stock -----------------------------------------------------------------
export function stockCategories() {
  return db
    .prepare(`SELECT category, COUNT(*) AS items FROM tally_stock_items GROUP BY category ORDER BY category`)
    .all();
}

export function stockItems({ search = '', category = '', status = 'all', sort = 'name', limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = {};
  // Every word must appear somewhere in the item, in any order — "taparia
  // plier" has to find "TAPARIA Combination Plier 150mm".
  const terms = String(search).trim().split(/\s+/).filter(Boolean).slice(0, 6);
  terms.forEach((term, i) => {
    where.push(`(name LIKE @q${i} OR alias LIKE @q${i} OR part_number LIKE @q${i} OR category LIKE @q${i})`);
    params[`q${i}`] = `%${term}%`;
  });
  if (category) {
    where.push('category = @category');
    params.category = category;
  }
  // An item's own reorder level wins. The configured figure is only a
  // fallback for items where nobody has set one in Tally -- MAX() would
  // override every deliberately-low level and flag half the shelf.
  const level = `CASE WHEN reorder_level > 0 THEN reorder_level ELSE ${Number(config.rules.defaultReorderLevel)} END`;
  if (status === 'out') where.push('closing_qty <= 0');
  else if (status === 'low') where.push(`closing_qty > 0 AND closing_qty <= ${level}`);
  else if (status === 'ok') where.push(`closing_qty > ${level}`);

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderBy =
    { name: 'name ASC', qty: 'closing_qty ASC', value: 'closing_value DESC', category: 'category ASC, name ASC' }[sort] ||
    'name ASC';

  const rows = db
    .prepare(
      `SELECT guid, name, alias, part_number, category, base_units, closing_qty, closing_rate,
              closing_value, standard_price, reorder_level,
              CASE WHEN closing_qty <= 0 THEN 'out'
                   WHEN closing_qty <= ${level} THEN 'low'
                   ELSE 'ok' END AS stock_status
       FROM tally_stock_items ${clause} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset });

  const total = db.prepare(`SELECT COUNT(*) AS n FROM tally_stock_items ${clause}`).get(params).n;
  return { rows, total };
}

export function stockSummary() {
  // An item's own reorder level wins. The configured figure is only a
  // fallback for items where nobody has set one in Tally -- MAX() would
  // override every deliberately-low level and flag half the shelf.
  const level = `CASE WHEN reorder_level > 0 THEN reorder_level ELSE ${Number(config.rules.defaultReorderLevel)} END`;
  return db
    .prepare(
      `SELECT COUNT(*) AS items,
              COALESCE(SUM(closing_value), 0) AS value,
              SUM(CASE WHEN closing_qty <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
              SUM(CASE WHEN closing_qty > 0 AND closing_qty <= ${level} THEN 1 ELSE 0 END) AS low_stock
       FROM tally_stock_items`
    )
    .get();
}

// --- receivables -----------------------------------------------------------
export function receivables() {
  const bills = db
    .prepare(`SELECT * FROM tally_bills WHERE amount > 0.01 ORDER BY bill_date ASC`)
    .all();
  const parties = new Map();
  const buckets = Object.fromEntries(AGEING_BUCKETS.map((b) => [b.key, { ...b, amount: 0, bills: 0 }]));
  let total = 0;
  let overdue = 0;

  const enriched = bills.map((b) => {
    const age = b.bill_date ? daysSince(b.bill_date) : 0;
    const dueDays = b.due_date
      ? daysSince(b.due_date)
      : age - (b.credit_period_days || config.rules.defaultCreditPeriodDays);
    const bucket = AGEING_BUCKETS.find((x) => age >= x.min && age <= x.max) || AGEING_BUCKETS[0];
    const row = { ...b, age_days: age, days_overdue: Math.max(0, dueDays), bucket: bucket.key, is_overdue: dueDays > 0 };

    total += b.amount;
    if (row.is_overdue) overdue += b.amount;
    buckets[bucket.key].amount += b.amount;
    buckets[bucket.key].bills += 1;

    if (!parties.has(b.party_name)) {
      parties.set(b.party_name, {
        party_name: b.party_name, total: 0, overdue: 0, bills: 0, oldest_days: 0,
        buckets: Object.fromEntries(AGEING_BUCKETS.map((x) => [x.key, 0])),
      });
    }
    const p = parties.get(b.party_name);
    p.total += b.amount;
    p.bills += 1;
    p.buckets[bucket.key] += b.amount;
    if (row.is_overdue) p.overdue += b.amount;
    p.oldest_days = Math.max(p.oldest_days, age);
    return row;
  });

  const ledgerInfo = db
    .prepare('SELECT name, credit_limit, credit_period_days, phone, state FROM tally_ledgers WHERE is_customer = 1')
    .all();
  const ledgerBy = new Map(ledgerInfo.map((l) => [l.name, l]));

  const partyRows = [...parties.values()]
    .map((p) => ({ ...p, ...(ledgerBy.get(p.party_name) || {}), name: undefined }))
    .sort((a, b) => b.total - a.total);

  return {
    total,
    overdue,
    billCount: enriched.length,
    partyCount: partyRows.length,
    buckets: AGEING_BUCKETS.map((b) => buckets[b.key]),
    parties: partyRows,
    bills: enriched,
  };
}

// --- orders (derived from Tally vouchers) ----------------------------------
/**
 * Phase 1's "pending vs dispatched" snapshot.
 *
 * A Sales Order counts as dispatched once a Delivery Note quotes it in its
 * Reference field. That is the only linkage Tally gives us from outside, and it
 * depends on the reference being typed consistently. Phase 2 replaces this
 * inference with an explicit order record that cannot drift.
 */
export function orderSnapshot({ days = 45 } = {}) {
  const since = isoDaysAgo(days);

  const orders = db
    .prepare(
      `SELECT so.guid, so.voucher_number, so.date, so.party_name, so.amount, so.reference, so.line_count,
              dn.voucher_number AS dispatch_number, dn.date AS dispatch_date,
              inv.voucher_number AS invoice_number, inv.date AS invoice_date
       FROM tally_vouchers so
       LEFT JOIN tally_vouchers dn
              ON dn.voucher_type = 'Delivery Note' AND dn.reference = so.voucher_number
       LEFT JOIN tally_vouchers inv
              ON inv.voucher_type = 'Sales' AND inv.reference = so.voucher_number
       WHERE so.voucher_type = 'Sales Order' AND so.date >= ?
       ORDER BY so.date DESC`
    )
    .all(since);

  const rows = orders.map((o) => {
    const ageDays = daysSince(o.date);
    const stage = o.invoice_number ? 'Invoiced' : o.dispatch_number ? 'Dispatched' : 'Pending dispatch';
    return { ...o, age_days: ageDays, stage, is_pending: !o.dispatch_number };
  });

  const pending = rows.filter((r) => r.is_pending);
  const todayStr = todayISO();

  return {
    windowDays: days,
    orders: rows,
    pending: {
      count: pending.length,
      value: pending.reduce((s, r) => s + r.amount, 0),
      agedOver3Days: pending.filter((r) => r.age_days > 3).length,
      oldestDays: pending.reduce((m, r) => Math.max(m, r.age_days), 0),
    },
    dispatchedToday: rows.filter((r) => r.dispatch_date === todayStr).length,
    invoicedToday: rows.filter((r) => r.invoice_date === todayStr).length,
    ordersToday: rows.filter((r) => r.date === todayStr).length,
  };
}

// --- overview --------------------------------------------------------------
export function salesTrend({ days = 30 } = {}) {
  const since = isoDaysAgo(days);
  return db
    .prepare(
      `SELECT date, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS invoices
       FROM tally_vouchers WHERE voucher_type = 'Sales' AND date >= ?
       GROUP BY date ORDER BY date`
    )
    .all(since);
}

export function salesByCategory({ days = 30 } = {}) {
  const since = isoDaysAgo(days);
  return db
    .prepare(
      `SELECT COALESCE(si.category, 'Uncategorised') AS category,
              COALESCE(SUM(vl.amount), 0) AS amount,
              COUNT(DISTINCT v.guid) AS invoices
       FROM tally_voucher_lines vl
       JOIN tally_vouchers v ON v.guid = vl.voucher_guid
       LEFT JOIN tally_stock_items si ON si.name = vl.item_name
       WHERE v.voucher_type = 'Sales' AND v.date >= ?
       GROUP BY category ORDER BY amount DESC`
    )
    .all(since);
}

export function topCustomers({ days = 90, limit = 8 } = {}) {
  const since = isoDaysAgo(days);
  return db
    .prepare(
      `SELECT party_name, SUM(amount) AS amount, COUNT(*) AS invoices
       FROM tally_vouchers WHERE voucher_type = 'Sales' AND date >= ?
       GROUP BY party_name ORDER BY amount DESC LIMIT ?`
    )
    .all(since, limit);
}

export function reorderList(limit = 25) {
  // An item's own reorder level wins. The configured figure is only a
  // fallback for items where nobody has set one in Tally -- MAX() would
  // override every deliberately-low level and flag half the shelf.
  const level = `CASE WHEN reorder_level > 0 THEN reorder_level ELSE ${Number(config.rules.defaultReorderLevel)} END`;
  return db
    .prepare(
      `SELECT name, category, base_units, closing_qty, reorder_level, standard_price,
              ${level} AS effective_level
       FROM tally_stock_items
       WHERE closing_qty <= ${level}
       ORDER BY (closing_qty - ${level}) ASC, closing_qty ASC
       LIMIT ?`
    )
    .all(limit);
}

export function overview() {
  const stock = stockSummary();
  const rec = receivables();
  const orders = orderSnapshot({ days: 45 });
  const trend = salesTrend({ days: 30 });
  return {
    stock,
    receivables: {
      total: rec.total,
      overdue: rec.overdue,
      billCount: rec.billCount,
      partyCount: rec.partyCount,
      buckets: rec.buckets,
      topParties: rec.parties.slice(0, 8),
    },
    orders: {
      pending: orders.pending,
      dispatchedToday: orders.dispatchedToday,
      invoicedToday: orders.invoicedToday,
      ordersToday: orders.ordersToday,
      stuck: orders.orders.filter((o) => o.is_pending && o.age_days > 3).slice(0, 10),
    },
    sales: {
      trend,
      last30: trend.reduce((s, d) => s + d.amount, 0),
      byCategory: salesByCategory({ days: 30 }).slice(0, 8),
      topCustomers: topCustomers({ days: 90, limit: 6 }),
    },
    reorder: reorderList(10),
    lastSync: lastSync(),
  };
}
