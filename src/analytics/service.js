/**
 * The dashboard's read models — the commercial view, as opposed to the
 * operational one the Overview screen already gives.
 *
 * WHAT COUNTS AS "BILLED" IS TALLY, ALWAYS.
 * Every money figure on this screen is a Sales voucher in the synced mirror.
 * Not the app's own `invoices` rows, which record that a tax invoice was
 * raised and link it to a bill, and not order values, which are what was
 * agreed rather than what went out. Only one of the three is the filed figure,
 * so only one of them is used, and mixing them would produce a total that
 * agrees with nothing.
 *
 * WHAT COUNTS AS "QUOTED" IS THIS APP.
 * Tally has no idea a quotation exists, so the quoted side can only come from
 * the quotations table — and only from quotes that actually left the building.
 * A draft is not a quotation to a customer, and counting one would flatter the
 * ratio with work nobody has seen.
 *
 * TIERS ARE RELATIVE, AND THAT IS DELIBERATE.
 * A customer is Platinum because of where they sit against the rest of the
 * book, not against a rupee figure typed into a config file. Absolute bands
 * would need a number nobody has agreed yet, and would quietly go wrong the
 * first year the business grows. Relative scoring is stated plainly on the
 * screen so nobody reads "Platinum" as an achievement rather than a ranking.
 */
import { db } from '../db/index.js';
import { todayISO, toISO } from '../lib/dates.js';
import { segmentByCustomer } from '../customers/service.js';

// --- months -----------------------------------------------------------------
// Everything here is keyed on 'YYYY-MM'. Tally dates are plain calendar dates
// with no zone, so month arithmetic is string work plus one Date for the
// rollover, and never a timestamp comparison.
const monthOf = (iso) => String(iso).slice(0, 7);

export const currentMonth = () => monthOf(todayISO());

export function addMonths(month, n) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const monthStart = (month) => `${month}-01`;

/** Day 0 of the following month is the last day of this one, leap years included. */
function monthEnd(month) {
  const [y, m] = String(month).split('-').map(Number);
  return toISO(new Date(y, m, 0));
}

const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v || ''));

/** The months running up to and including `month`, oldest first. */
function monthRange(month, count) {
  return Array.from({ length: count }, (_, i) => addMonths(month, i - (count - 1)));
}

/**
 * Item name to brand, deduplicated.
 *
 * Tally's stock list has a handful of items sharing a name ("GROZ Socket"
 * appears six times), so joining voucher lines straight onto it fans a line
 * out into several and inflates every brand total by a couple of percent.
 * Collapsing to one brand per name first is what keeps brand-wise sales
 * summing back to the billed figure.
 */
const BRAND_OF = `
  SELECT si.name AS item_name, MIN(ci.brand) AS brand
  FROM tally_stock_items si
  JOIN catalogue_items ci ON ci.tally_guid = si.guid
  WHERE ci.brand IS NOT NULL AND TRIM(ci.brand) <> ''
  GROUP BY si.name`;

const UNMAPPED = 'Not in the catalogue';

// --- billing ----------------------------------------------------------------
function billedByMonth(from, to) {
  return db
    .prepare(
      `SELECT substr(date, 1, 7) AS month,
              COALESCE(SUM(amount), 0) AS value,
              COUNT(*)               AS invoices,
              COUNT(DISTINCT party_name) AS customers
       FROM tally_vouchers
       WHERE voucher_type = 'Sales' AND date BETWEEN ? AND ?
       GROUP BY month`
    )
    .all(from, to);
}

/**
 * Quotations issued, by month.
 *
 * Dated by `quote_date` — the date the quotation is issued under, which is the
 * date the customer sees and not the row's created_at. Only current versions
 * count: a quote revised three times is one quotation, and it belongs to the
 * month of the version that stands.
 */
function quotedByMonth(from, to) {
  return db
    .prepare(
      `SELECT substr(COALESCE(quote_date, date(sent_at), date(created_at)), 1, 7) AS month,
              COALESCE(SUM(total), 0) AS value,
              COUNT(*) AS quotations,
              COUNT(DISTINCT customer_name) AS customers,
              COALESCE(SUM(CASE WHEN status = 'accepted' THEN total ELSE 0 END), 0) AS accepted_value,
              SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted
       FROM quotations
       WHERE is_current = 1
         AND status IN ('sent', 'accepted', 'lost')
         AND COALESCE(quote_date, date(sent_at), date(created_at)) BETWEEN ? AND ?
       GROUP BY month`
    )
    .all(from, to);
}

// --- scoring ----------------------------------------------------------------
/**
 * Score every row 1–5 on one dimension, by where it sits in the spread.
 *
 * Ties are scored on the midpoint of the block they form rather than its top
 * edge. It matters more than it sounds: most of the book buys from one or two
 * brands, so a top-edge rule would hand that whole block a 3 and leave the
 * genuinely broad buyers indistinguishable from them.
 */
function quintiles(rows, key) {
  const n = rows.length;
  if (!n) return;
  const sorted = rows.map((r) => Number(r[key]) || 0).sort((a, b) => a - b);
  const below = (v) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const upTo = (v) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const row of rows) {
    const v = Number(row[key]) || 0;
    const share = (below(v) + upTo(v)) / (2 * n);
    row[`${key}_score`] = Math.min(5, Math.max(1, Math.ceil(share * 5) || 1));
  }
}

export const TIER_BANDS = [
  { key: 'platinum', label: 'Platinum', min: 13, high: true, note: 'Top of the book on breadth, frequency and value together.' },
  { key: 'gold', label: 'Gold', min: 10, high: true, note: 'Strong on at least two of the three.' },
  { key: 'silver', label: 'Silver', min: 7, high: false, note: 'Steady, middling on most measures.' },
  { key: 'bronze', label: 'Bronze', min: 3, high: false, note: 'Occasional, narrow, or small.' },
];

const tierFor = (score) => TIER_BANDS.find((b) => score >= b.min) || TIER_BANDS[TIER_BANDS.length - 1];

export const HIGH_TIERS = TIER_BANDS.filter((b) => b.high).map((b) => b.key);

// --- segments ---------------------------------------------------------------
/**
 * The industry a customer is in, which is a fact about them rather than
 * anything derived from their trading.
 *
 * Tiers already rank customers by what they are worth. This answers the other
 * question — WHO are we selling to — and it is the one that separates "we had
 * a bad month" from "pharma had a bad month". Nothing here computes it: it is
 * typed in once per customer and lives in `customer_segments`, because Tally's
 * ledger groups are salesmen and territory and cannot be made to mean this.
 *
 * Customers with nothing assigned are counted under UNASSIGNED rather than
 * dropped. A segment breakdown that silently omits a third of the book looks
 * complete and is not, and the size of that bucket is the only thing that says
 * how far the categorising has actually got.
 */
export const UNASSIGNED = 'Unassigned';

// --- the customer table -----------------------------------------------------
/**
 * Every customer with a billing history, scored and segmented as at the end of
 * the selected month.
 *
 * The window ends with the selected month rather than with today, so looking
 * back at July shows the tiers that were true in July instead of re-judging
 * that month with knowledge nobody had at the time.
 */
export function customerTiers({ month = currentMonth(), windowMonths = 6 } = {}) {
  const from = monthStart(addMonths(month, -(windowMonths - 1)));
  const to = monthEnd(month);
  const prevFrom = monthStart(addMonths(month, -(windowMonths * 2 - 1)));
  const prevTo = monthEnd(addMonths(month, -windowMonths));

  const base = db
    .prepare(
      `SELECT v.party_name AS customer,
              COUNT(*) AS invoices,
              COALESCE(SUM(v.amount), 0) AS value,
              COUNT(DISTINCT substr(v.date, 1, 7)) AS active_months,
              MAX(v.date) AS last_billed
       FROM tally_vouchers v
       WHERE v.voucher_type = 'Sales' AND v.date BETWEEN ? AND ?
       GROUP BY v.party_name`
    )
    .all(from, to);

  const brands = db
    .prepare(
      `SELECT v.party_name AS customer, COUNT(DISTINCT b.brand) AS brands
       FROM tally_voucher_lines vl
       JOIN tally_vouchers v ON v.guid = vl.voucher_guid
       JOIN (${BRAND_OF}) b ON b.item_name = vl.item_name
       WHERE v.voucher_type = 'Sales' AND v.date BETWEEN ? AND ?
       GROUP BY v.party_name`
    )
    .all(from, to);
  const brandBy = new Map(brands.map((b) => [b.customer, b.brands]));

  const previous = db
    .prepare(
      `SELECT party_name AS customer, COALESCE(SUM(amount), 0) AS value, COUNT(*) AS invoices
       FROM tally_vouchers
       WHERE voucher_type = 'Sales' AND date BETWEEN ? AND ?
       GROUP BY party_name`
    )
    .all(prevFrom, prevTo);
  const previousBy = new Map(previous.map((p) => [p.customer, p]));

  // All-time, so that "new" means new to the business and not merely new to
  // the window — a customer of eight years who skipped a quarter is not a lead.
  const firstBilled = db
    .prepare(
      `SELECT party_name AS customer, MIN(date) AS first_billed
       FROM tally_vouchers WHERE voucher_type = 'Sales' GROUP BY party_name`
    )
    .all();
  const firstBy = new Map(firstBilled.map((f) => [f.customer, f.first_billed]));

  const asOf = month === currentMonth() ? todayISO() : to;
  const daysBetween = (a, b) =>
    Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

  const rows = base.map((r) => {
    const prev = previousBy.get(r.customer);
    return {
      ...r,
      brands: brandBy.get(r.customer) || 0,
      // Expressed per month so the three dimensions are comparable across a
      // window of any length, and so a short window cannot inflate anyone.
      frequency: r.invoices / windowMonths,
      monetary: r.value / windowMonths,
      previous_value: prev?.value || 0,
      previous_invoices: prev?.invoices || 0,
      avg_month_value: r.active_months ? r.value / r.active_months : 0,
      last_billed: r.last_billed,
      days_since_billed: r.last_billed ? daysBetween(r.last_billed, asOf) : null,
      first_billed: firstBy.get(r.customer) || null,
      first_billed_days_ago: firstBy.get(r.customer) ? daysBetween(firstBy.get(r.customer), asOf) : null,
    };
  });

  quintiles(rows, 'brands');
  quintiles(rows, 'frequency');
  quintiles(rows, 'monetary');

  const segments = segmentByCustomer();

  for (const row of rows) {
    row.score = row.brands_score + row.frequency_score + row.monetary_score;
    const band = tierFor(row.score);
    row.tier = band.key;
    row.tier_label = band.label;
    row.segment = segments.get(row.customer) || UNASSIGNED;
  }

  rows.sort((a, b) => b.score - a.score || b.value - a.value);
  return { rows, from, to, windowMonths };
}

// --- brand-wise sales -------------------------------------------------------
export function brandSales({ month = currentMonth(), months = 6 } = {}) {
  const span = monthRange(month, months);
  const from = monthStart(span[0]);
  const to = monthEnd(month);

  const rows = db
    .prepare(
      `SELECT COALESCE(b.brand, @unmapped) AS brand,
              substr(v.date, 1, 7) AS month,
              COALESCE(SUM(vl.amount), 0) AS value,
              COUNT(DISTINCT v.party_name) AS customers,
              COUNT(DISTINCT v.guid) AS invoices
       FROM tally_voucher_lines vl
       JOIN tally_vouchers v ON v.guid = vl.voucher_guid
       LEFT JOIN (${BRAND_OF}) b ON b.item_name = vl.item_name
       WHERE v.voucher_type = 'Sales' AND v.date BETWEEN @from AND @to
       GROUP BY brand, month`
    )
    .all({ from, to, unmapped: UNMAPPED });

  const byBrand = new Map();
  for (const r of rows) {
    if (!byBrand.has(r.brand)) {
      byBrand.set(r.brand, { brand: r.brand, value: 0, customers: 0, invoices: 0, byMonth: {} });
    }
    const b = byBrand.get(r.brand);
    b.byMonth[r.month] = r.value;
    b.value += r.value;
    if (r.month === month) {
      // The headline columns are the selected month. The window total behind
      // them is only there to order the table sensibly when a brand has a
      // quiet month.
      b.customers = r.customers;
      b.invoices = r.invoices;
      b.monthValue = r.value;
    }
  }

  const list = [...byBrand.values()].map((b) => ({
    ...b,
    monthValue: b.monthValue || 0,
    trend: span.map((m) => b.byMonth[m] || 0),
  }));

  const monthTotal = list.reduce((n, b) => n + b.monthValue, 0);
  const windowTotal = list.reduce((n, b) => n + b.value, 0);
  // Unmatched lines always sort last however much they are worth: they are a
  // data-quality row sitting in a list of brands, not a brand that outsold one.
  list.sort((a, b) =>
    (a.brand === UNMAPPED) - (b.brand === UNMAPPED) ||
    b.monthValue - a.monthValue || b.value - a.value);

  return {
    months: span,
    brands: list.map((b) => ({
      ...b,
      share: monthTotal ? b.monthValue / monthTotal : 0,
      windowShare: windowTotal ? b.value / windowTotal : 0,
    })),
    monthTotal,
    windowTotal,
    // Lines whose item is not matched to a catalogue entry have no brand to
    // report. Shown rather than dropped: it is the size of a data problem,
    // and dropping it would make the brand columns quietly fail to add up.
    unmappedValue: list.find((b) => b.brand === UNMAPPED)?.monthValue || 0,
  };
}

// --- segment-wise sales -----------------------------------------------------
/**
 * Billed value by industry, month by month.
 *
 * Voucher-level rather than line-level, because a segment belongs to the
 * customer and not to the item: the whole of an invoice counts towards
 * whatever industry the party is in. That also keeps this immune to the
 * duplicate-item-name problem the brand query has to work around —
 * `customer_segments.customer_name` is unique, so the join cannot fan a
 * voucher out into two.
 */
export function segmentSales({ month = currentMonth(), months = 6 } = {}) {
  const span = monthRange(month, months);
  const from = monthStart(span[0]);
  const to = monthEnd(month);

  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(cs.segment), ''), @unassigned) AS segment,
              substr(v.date, 1, 7) AS month,
              COALESCE(SUM(v.amount), 0) AS value,
              COUNT(*) AS invoices,
              COUNT(DISTINCT v.party_name) AS customers
       FROM tally_vouchers v
       LEFT JOIN customer_segments cs ON cs.customer_name = v.party_name
       WHERE v.voucher_type = 'Sales' AND v.date BETWEEN @from AND @to
       GROUP BY segment, month`
    )
    .all({ from, to, unassigned: UNASSIGNED });

  const bySegment = new Map();
  for (const r of rows) {
    if (!bySegment.has(r.segment)) {
      bySegment.set(r.segment, { segment: r.segment, value: 0, customers: 0, invoices: 0, byMonth: {} });
    }
    const seg = bySegment.get(r.segment);
    seg.byMonth[r.month] = r.value;
    seg.value += r.value;
    if (r.month === month) {
      seg.customers = r.customers;
      seg.invoices = r.invoices;
      seg.monthValue = r.value;
    }
  }

  const list = [...bySegment.values()].map((seg) => ({
    ...seg,
    monthValue: seg.monthValue || 0,
    trend: span.map((m) => seg.byMonth[m] || 0),
  }));

  const monthTotal = list.reduce((n, seg) => n + seg.monthValue, 0);
  const windowTotal = list.reduce((n, seg) => n + seg.value, 0);
  // Unassigned sorts last whatever it is worth. It is the work still to do,
  // not the biggest industry, and putting it at the top would read as one.
  list.sort((a, b) =>
    (a.segment === UNASSIGNED) - (b.segment === UNASSIGNED) ||
    b.monthValue - a.monthValue || b.value - a.value);

  return {
    months: span,
    segments: list.map((seg) => ({
      ...seg,
      share: monthTotal ? seg.monthValue / monthTotal : 0,
      windowShare: windowTotal ? seg.value / windowTotal : 0,
    })),
    monthTotal,
    windowTotal,
    unassignedValue: list.find((seg) => seg.segment === UNASSIGNED)?.monthValue || 0,
  };
}

// --- the gaps ---------------------------------------------------------------
/** Who was billed in a given month, as a set of names. */
function billedIn(month) {
  return new Set(
    db
      .prepare(
        `SELECT DISTINCT party_name FROM tally_vouchers
         WHERE voucher_type = 'Sales' AND date BETWEEN ? AND ?`
      )
      .all(monthStart(month), monthEnd(month))
      .map((r) => r.party_name)
  );
}

/** Who was quoted in a given month, as a set of names. */
function quotedIn(month) {
  return new Set(
    db
      .prepare(
        `SELECT DISTINCT customer_name FROM quotations
         WHERE is_current = 1 AND status IN ('sent', 'accepted', 'lost')
           AND COALESCE(quote_date, date(sent_at), date(created_at)) BETWEEN ? AND ?`
      )
      .all(monthStart(month), monthEnd(month))
      .map((r) => r.customer_name)
  );
}

// --- the whole screen -------------------------------------------------------
export function dashboard({ month, windowMonths = 6, trendMonths = 12 } = {}) {
  const selected = isMonth(month) ? month : currentMonth();
  const trendSpan = monthRange(selected, trendMonths);
  const from = monthStart(trendSpan[0]);
  const to = monthEnd(selected);

  const billed = new Map(billedByMonth(from, to).map((r) => [r.month, r]));
  const quoted = new Map(quotedByMonth(from, to).map((r) => [r.month, r]));

  const months = trendSpan.map((m) => {
    const b = billed.get(m) || { value: 0, invoices: 0, customers: 0 };
    const qm = quoted.get(m) || { value: 0, quotations: 0, customers: 0, accepted_value: 0, accepted: 0 };
    return {
      month: m,
      billedValue: b.value,
      billedInvoices: b.invoices,
      customersBilled: b.customers,
      quotedValue: qm.value,
      quotations: qm.quotations,
      customersQuoted: qm.customers,
      acceptedValue: qm.accepted_value,
      accepted: qm.accepted,
      // Null rather than zero when there is nothing billed: a ratio against no
      // billing is undefined, and showing 0.00 would read as "we quoted
      // nothing" when it means "nothing was billed to compare against".
      ratio: b.value > 0 ? qm.value / b.value : null,
    };
  });

  const thisMonth = months[months.length - 1];
  const tiers = customerTiers({ month: selected, windowMonths });
  const byTier = Object.fromEntries(
    TIER_BANDS.map((band) => [
      band.key,
      {
        ...band,
        customers: tiers.rows.filter((r) => r.tier === band.key).length,
        value: tiers.rows.filter((r) => r.tier === band.key).reduce((n, r) => n + r.value, 0),
      },
    ])
  );

  // Sales by industry for the month, with the size of the book behind each one
  // so a segment that billed nothing this month is still visible as a segment
  // rather than disappearing off the card.
  const sales = segmentSales({ month: selected, months: windowMonths });
  const bookBySegment = new Map();
  for (const r of tiers.rows) {
    bookBySegment.set(r.segment, (bookBySegment.get(r.segment) || 0) + 1);
  }
  const segments = sales.segments.map((seg) => ({
    ...seg,
    customersInBook: bookBySegment.get(seg.segment) || 0,
    unassigned: seg.segment === UNASSIGNED,
  }));
  // A segment nobody bought from this month still belongs on the screen.
  for (const [segment, customersInBook] of bookBySegment) {
    if (!segments.some((seg) => seg.segment === segment)) {
      segments.push({
        segment, value: 0, monthValue: 0, customers: 0, invoices: 0,
        share: 0, windowShare: 0, trend: sales.months.map(() => 0),
        customersInBook, unassigned: segment === UNASSIGNED,
      });
    }
  }

  const billedThisMonth = billedIn(selected);
  const quotedThisMonth = quotedIn(selected);
  const high = tiers.rows.filter((r) => HIGH_TIERS.includes(r.tier));

  const gapRow = (r) => ({
    customer: r.customer,
    tier: r.tier,
    tier_label: r.tier_label,
    segment: r.segment,
    value: r.value,
    avg_month_value: r.avg_month_value,
    invoices: r.invoices,
    brands: r.brands,
    last_billed: r.last_billed,
    days_since_billed: r.days_since_billed,
  });

  return {
    month: selected,
    isCurrentMonth: selected === currentMonth(),
    today: todayISO(),
    window: { months: windowMonths, from: tiers.from, to: tiers.to },
    monthsAvailable: availableMonths(),
    months,
    headline: {
      billedValue: thisMonth.billedValue,
      billedInvoices: thisMonth.billedInvoices,
      customersBilled: thisMonth.customersBilled,
      quotedValue: thisMonth.quotedValue,
      quotations: thisMonth.quotations,
      ratio: thisMonth.ratio,
      // The book behind the month, so a quiet month is read against the size
      // of the customer base rather than in isolation.
      customersInWindow: tiers.rows.length,
      highTierCustomers: high.length,
    },
    tiers: {
      bands: TIER_BANDS.map((b) => byTier[b.key]),
      customers: tiers.rows,
      // Named so the screen can explain itself without hard-coding the rule
      // in two places.
      basis: {
        brands: 'Distinct brands bought in the window',
        frequency: 'Sales invoices per month',
        monetary: 'Billed value per month',
      },
    },
    segments,
    segmentTotals: {
      months: sales.months,
      monthTotal: sales.monthTotal,
      windowTotal: sales.windowTotal,
      unassignedValue: sales.unassignedValue,
      unassignedCustomers: bookBySegment.get(UNASSIGNED) || 0,
      assignedCustomers: tiers.rows.length - (bookBySegment.get(UNASSIGNED) || 0),
    },
    gaps: {
      notBilled: high
        .filter((r) => !billedThisMonth.has(r.customer))
        .map(gapRow)
        .sort((a, b) => b.avg_month_value - a.avg_month_value),
      notQuoted: high
        .filter((r) => !quotedThisMonth.has(r.customer))
        .map(gapRow)
        .sort((a, b) => b.avg_month_value - a.avg_month_value),
      // Without this the "not quoted" list is every high-tier customer and
      // reads as an alarm, when it actually means no quotation has been
      // recorded in the app for that month at all.
      quotationsRecorded: quotedThisMonth.size,
    },
  };
}

/** Months there is anything to look at, newest first. */
export function availableMonths() {
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(date, 1, 7) AS month FROM tally_vouchers WHERE voucher_type = 'Sales'
       UNION
       SELECT DISTINCT substr(COALESCE(quote_date, date(sent_at), date(created_at)), 1, 7)
       FROM quotations WHERE is_current = 1`
    )
    .all()
    .map((r) => r.month)
    .filter(isMonth);
  const set = new Set(rows);
  set.add(currentMonth());
  return [...set].sort().reverse();
}
