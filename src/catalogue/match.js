/**
 * Matching the quotation catalogue to Tally stock items.
 *
 * These are two independently-maintained lists. The price list is keyed on the
 * manufacturer's part number; Tally items are named however whoever created
 * them that day decided to name them. Nothing is matched on a guess: every
 * match records HOW it was made, and anything uncertain is left unmatched and
 * surfaced rather than quietly wired up to the wrong stock figure.
 *
 * Order of attempts, most trustworthy first:
 *   1. exact        — Tally's part number equals the catalogue code
 *   2. code-in-name — the code appears as a distinct token in the Tally name
 *   3. name         — descriptions normalise to the same string
 *   4. unmatched    — left alone, listed for a human
 *
 * A manual match set by a person is never overwritten by a later run.
 */
import { db } from '../db/index.js';

/**
 * Reduce a product name to something comparable across the two lists.
 *
 * Both sides must be stripped the same way or they can never compare equal:
 * the catalogue says "COMBINATION PLIERS 8" while Tally says "TAPARIA 1621-8
 * COMBINATION PLIERS 8". Brand words and the part number are noise for this
 * purpose, so both come out, whichever list they came from.
 */
export function normaliseName(name, brandWords = null, code = '') {
  const raw = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  if (!raw) return '';

  const codeToken = codeKey(code);
  const tokens = raw.split(' ').filter((t) => {
    if (!t) return false;
    if (brandWords && brandWords.has(t)) return false;
    if (codeToken && t === codeToken) return false;
    return true;
  });
  return tokens.join(' ');
}

const codeKey = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function matchCatalogue() {
  const catalogue = db
    .prepare(`SELECT code, name, brand, tally_guid, match_method FROM catalogue_items`)
    .all();
  const stock = db
    .prepare(`SELECT guid, name, part_number, alias FROM tally_stock_items`)
    .all();

  // Every word that appears in any brand name, so both sides can have the
  // brand stripped out identically.
  const brandWords = new Set();
  for (const c of catalogue) {
    for (const w of String(c.brand || '').toUpperCase().split(/[^A-Z0-9]+/)) {
      if (w.length > 1) brandWords.add(w);
    }
  }

  // Indexes, built once. 12k x 3.7k would otherwise be 45M comparisons.
  const byPart = new Map();
  const byNormName = new Map();
  const nameTokens = [];

  for (const s of stock) {
    for (const candidate of [s.part_number, s.alias]) {
      const k = codeKey(candidate);
      if (k && !byPart.has(k)) byPart.set(k, s);
    }
    // Raw tokens are what a code is hunted for; the stripped form is what
    // descriptions are compared on.
    nameTokens.push({ item: s, tokens: new Set(normaliseName(s.name).split(' ')) });
    const n = normaliseName(s.name, brandWords, s.part_number || s.alias);
    if (n && !byNormName.has(n)) byNormName.set(n, s);
  }

  const stats = { exact: 0, 'code-in-name': 0, name: 0, unmatched: 0, manual: 0, ambiguous: 0, contested: 0 };
  const resolved = new Map(); // catalogue code -> { guid, method, score }

  // A Tally item belongs to at most ONE catalogue code. Without this, two
  // different SKUs quietly read the same stock figure, which is worse than
  // showing no stock at all.
  const claimed = new Map(); // tally guid -> catalogue code
  const claim = (item, guid, method, score) => {
    if (claimed.has(guid)) {
      stats.contested += 1;
      return false;
    }
    claimed.set(guid, item.code);
    resolved.set(item.code, { guid, method, score });
    stats[method] += 1;
    return true;
  };

  // Manual decisions are made by a person and survive every later run.
  const pending = [];
  for (const item of catalogue) {
    if (item.match_method === 'manual' && item.tally_guid) {
      claimed.set(item.tally_guid, item.code);
      stats.manual += 1;
    } else {
      pending.push(item);
    }
  }

  // Pass 1 — part number. The only match worth trusting without a look.
  const afterExact = [];
  for (const item of pending) {
    const key = codeKey(item.code);
    const hit = key ? byPart.get(key) : null;
    if (!hit || !claim(item, hit.guid, 'exact', 1)) afterExact.push(item);
  }

  // Pass 2 — the code is sitting inside the Tally item name, which happens
  // whenever the part number field was left blank.
  //
  // Driven from the unmatched TALLY items, not the catalogue: a code like
  // "DN-4853" tokenises to "DN" + "4853", so searching for it as a single
  // token never finds it. Rebuilding candidate codes out of adjacent tokens
  // and looking those up is both correct and cheap — a few hundred stock items
  // instead of thousands of codes against thousands of names.
  const codeIndex = new Map();
  for (const item of afterExact) {
    const k = codeKey(item.code);
    if (k.length < 4) continue;
    codeIndex.set(k, codeIndex.has(k) ? null : item); // null marks an ambiguous code
  }

  for (const st of stock) {
    if (claimed.has(st.guid)) continue;
    const toks = normaliseName(st.name).split(' ').filter(Boolean);

    const candidates = new Set();
    for (let i = 0; i < toks.length; i++) {
      let acc = '';
      for (let n = 0; n < 4 && i + n < toks.length; n++) {
        acc += toks[i + n];
        if (acc.length >= 4) candidates.add(acc);
      }
    }

    const hits = [...new Set([...candidates].map((k) => codeIndex.get(k)).filter(Boolean))];
    if (hits.length === 1) {
      if (claim(hits[0], st.guid, 'code-in-name', 0.9)) codeIndex.delete(codeKey(hits[0].code));
    } else if (hits.length > 1) {
      stats.ambiguous += 1;
    }
  }

  const afterCode = afterExact.filter((item) => !resolved.has(item.code));

  // Pass 3 — descriptions normalise to the same string. Weakest signal, so it
  // only gets what the first two passes left behind.
  const stillOpen = [];
  for (const item of afterCode) {
    const n = normaliseName(item.name, brandWords, item.code);
    const hit = n ? byNormName.get(n) : null;
    if (!hit || claimed.has(hit.guid) || !claim(item, hit.guid, 'name', 0.75)) stillOpen.push(item);
  }
  stats.unmatched = stillOpen.length;

  const update = db.prepare(
    `UPDATE catalogue_items SET tally_guid = ?, match_method = ?, match_score = ?, updated_at = datetime('now') WHERE code = ?`
  );
  db.transaction(() => {
    for (const [code, m] of resolved) update.run(m.guid, m.method, m.score, code);
    for (const item of stillOpen) update.run(null, 'unmatched', 0, item.code);
  })();

  return {
    ...stats,
    catalogueItems: catalogue.length,
    stockItems: stock.length,
    matched: stats.exact + stats['code-in-name'] + stats.name + stats.manual,
  };
}

/** Catalogue items with no Tally item — quotable, but stock is unknown. */
export function unmatchedItems(limit = 200) {
  return db
    .prepare(
      `SELECT code, name, brand, category, list_rate FROM catalogue_items
       WHERE tally_guid IS NULL ORDER BY brand, code LIMIT ?`
    )
    .all(limit);
}

/** Tally items no catalogue row points at — stocked, but not quotable. */
export function orphanStockItems(limit = 200) {
  return db
    .prepare(
      `SELECT s.guid, s.name, s.part_number, s.closing_qty, s.base_units, s.closing_value
       FROM tally_stock_items s
       WHERE NOT EXISTS (SELECT 1 FROM catalogue_items c WHERE c.tally_guid = s.guid)
         AND s.closing_qty > 0
       ORDER BY s.closing_value DESC LIMIT ?`
    )
    .all(limit);
}

export function matchSummary() {
  const rows = db
    .prepare(`SELECT match_method, COUNT(*) AS n FROM catalogue_items GROUP BY match_method`)
    .all();
  const total = rows.reduce((s, r) => s + r.n, 0);
  const matched = rows.filter((r) => r.match_method !== 'unmatched').reduce((s, r) => s + r.n, 0);
  return {
    total,
    matched,
    unmatched: total - matched,
    byMethod: Object.fromEntries(rows.map((r) => [r.match_method, r.n])),
    orphanStock: db
      .prepare(
        `SELECT COUNT(*) AS n FROM tally_stock_items s
         WHERE NOT EXISTS (SELECT 1 FROM catalogue_items c WHERE c.tally_guid = s.guid)`
      )
      .get().n,
  };
}

/**
 * Catalogue rows joined to whatever Tally knows about them.
 * This is the query the quotation screen quotes from.
 */
export function searchCatalogue({ search = '', brand = '', category = '', stocked = 'all', customer = '', limit = 50 } = {}) {
  const where = [];
  const params = {};

  String(search).trim().split(/\s+/).filter(Boolean).slice(0, 6).forEach((term, i) => {
    where.push(`(c.name LIKE @q${i} OR c.code LIKE @q${i} OR c.brand LIKE @q${i} OR c.hsn LIKE @q${i})`);
    params[`q${i}`] = `%${term}%`;
  });
  if (brand) { where.push('c.brand = @brand'); params.brand = brand; }
  if (category) { where.push('c.category = @category'); params.category = category; }
  if (stocked === 'yes') where.push('c.tally_guid IS NOT NULL');
  else if (stocked === 'no') where.push('c.tally_guid IS NULL');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // When quoting for a named customer, carry the rate they were last actually
  // charged for each item. One windowed pass over their sales history rather
  // than a lookup per line.
  const withLastRate = Boolean(customer);
  if (withLastRate) params.customer = customer;

  const rows = db.prepare(
    `${withLastRate ? `WITH last_sale AS (
       SELECT si.guid AS item_guid, vl.rate, v.date, v.voucher_number,
              ROW_NUMBER() OVER (PARTITION BY si.guid ORDER BY v.date DESC, v.guid DESC) AS rn
       FROM tally_voucher_lines vl
       JOIN tally_vouchers v ON v.guid = vl.voucher_guid
       JOIN tally_stock_items si ON si.name = vl.item_name
       WHERE v.voucher_type = 'Sales' AND v.party_name = @customer
     )` : ''}
     SELECT c.code, c.name, c.brand, c.category, c.units, c.list_rate, c.gst_rate, c.hsn,
            c.match_method, c.tally_guid, s.closing_qty, s.base_units, s.closing_rate, s.reorder_level
            ${withLastRate ? ', ls.rate AS last_rate, ls.date AS last_rate_date, ls.voucher_number AS last_rate_invoice' : ''}
     FROM catalogue_items c
     LEFT JOIN tally_stock_items s ON s.guid = c.tally_guid
     ${withLastRate ? 'LEFT JOIN last_sale ls ON ls.item_guid = c.tally_guid AND ls.rn = 1' : ''}
     ${clause}
     ORDER BY (c.tally_guid IS NULL), c.brand, c.name
     LIMIT @limit`
  ).all({ ...params, limit });

  const total = db.prepare(`SELECT COUNT(*) AS n FROM catalogue_items c ${clause}`).get(params).n;
  return { rows, total };
}

export function catalogueFacets() {
  return {
    brands: db.prepare('SELECT brand, COUNT(*) AS n FROM catalogue_items GROUP BY brand ORDER BY n DESC').all(),
    categories: db.prepare('SELECT category, COUNT(*) AS n FROM catalogue_items GROUP BY category ORDER BY n DESC').all(),
  };
}

/**
 * The last rate actually charged to this customer for this item, from Tally's
 * own sales history. The single most useful number on a repeat quote.
 */
export function lastRateFor(customerName, itemGuid) {
  if (!customerName || !itemGuid) return null;
  return db.prepare(
    `SELECT vl.rate, v.date, v.voucher_number
     FROM tally_voucher_lines vl
     JOIN tally_vouchers v ON v.guid = vl.voucher_guid
     JOIN tally_stock_items s ON s.name = vl.item_name
     WHERE v.voucher_type = 'Sales' AND v.party_name = ? AND s.guid = ?
     ORDER BY v.date DESC LIMIT 1`
  ).get(customerName, itemGuid) || null;
}
