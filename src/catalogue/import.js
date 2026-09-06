import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { guessMapping, toCatalogueItem } from './normalise.js';

/**
 * Read a price-list workbook the way the quotation tool does: find the first
 * row with at least three filled cells and treat it as the header.
 */
export function readWorkbook(filePath, sheetName) {
  const wb = XLSX.readFile(filePath);
  const name = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });

  let headerIndex = 0;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    if (aoa[i].filter((c) => String(c).trim() !== '').length >= 3) {
      headerIndex = i;
      break;
    }
  }

  const headers = (aoa[headerIndex] || []).map((h, i) => String(h).trim() || `Column ${i + 1}`);
  const rows = aoa
    .slice(headerIndex + 1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));

  return { sheetNames: wb.SheetNames, sheet: name, headers, rows };
}

/**
 * Import a price list into catalogue_items.
 *
 * Codes are the part number, which is unique across all 12,261 rows of the
 * current list including across brands, so it is safe as the key. An existing
 * item keeps its Tally match when re-imported — a new price list must not
 * throw away matching work.
 */
export function importCatalogue(filePath, { sheet, replace = false, mapping: given } = {}) {
  const { rows, headers, sheet: usedSheet, sheetNames } = readWorkbook(filePath, sheet);
  const mapping = given || guessMapping(headers);

  const items = [];
  const skipped = [];
  for (const row of rows) {
    const item = toCatalogueItem(row, mapping);
    if (item) items.push(item);
    else skipped.push(row);
  }

  // Last one wins on a duplicate code, same as the quotation tool's dedupe.
  const byCode = new Map();
  let duplicates = 0;
  for (const item of items) {
    if (byCode.has(item.code)) duplicates += 1;
    byCode.set(item.code, item);
  }
  const unique = [...byCode.values()];

  const importedAt = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO catalogue_items (code, name, brand, category, units, list_rate, gst_rate, hsn,
      match_method, imported_at, updated_at)
    VALUES (@code, @name, @brand, @category, @units, @list_rate, @gst_rate, @hsn,
      'unmatched', @imported_at, @imported_at)
    ON CONFLICT(code) DO UPDATE SET
      name=excluded.name, brand=excluded.brand, category=excluded.category,
      units=excluded.units, list_rate=excluded.list_rate, gst_rate=excluded.gst_rate,
      hsn=excluded.hsn, imported_at=excluded.imported_at, updated_at=excluded.imported_at`);

  const before = db.prepare('SELECT COUNT(*) AS n FROM catalogue_items').get().n;

  db.transaction(() => {
    if (replace) db.prepare('DELETE FROM catalogue_items').run();
    for (const it of unique) {
      upsert.run({
        code: it.code, name: it.name, brand: it.brand, category: it.category,
        units: it.units, list_rate: it.listRate, gst_rate: it.gstRate, hsn: it.hsn,
        imported_at: importedAt,
      });
    }
  })();

  const after = db.prepare('SELECT COUNT(*) AS n FROM catalogue_items').get().n;

  return {
    file: path.basename(filePath),
    sheet: usedSheet,
    sheetNames,
    headers,
    mapping,
    rowsRead: rows.length,
    imported: unique.length,
    added: after - before,
    updated: unique.length - Math.max(0, after - before),
    duplicateCodes: duplicates,
    skippedRows: skipped.length,
    missingHsn: unique.filter((i) => i.missingHsn).length,
    zeroPrice: unique.filter((i) => i.zeroPrice).length,
    brands: [...new Set(unique.map((i) => i.brand))].sort(),
    importedAt,
  };
}

/**
 * Write the seed the simulated Tally stocks itself from.
 *
 * Without this the fake Tally invents its own products and the catalogue can
 * never be matched against anything real, which is exactly the integration
 * that needs proving before the office Tally is connected. A distributor
 * quotes far more than it stocks, so only a slice of the catalogue is stocked
 * — and the leftover is a genuine "quotable but not stocked" gap, not a bug.
 */
export function writeTallySeed({ stockedFraction = 0.38 } = {}) {
  const items = db
    .prepare('SELECT code, name, brand, category, units, list_rate, gst_rate, hsn FROM catalogue_items ORDER BY code')
    .all();
  if (!items.length) return { written: false, reason: 'catalogue is empty' };

  // Deterministic pick so the simulated company is stable across restarts.
  let h = 2166136261;
  const hash = (s) => {
    let x = h;
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 16777619);
    }
    return (x >>> 0) / 4294967296;
  };

  // A distributor stocks fast-moving consumables and orders expensive kit in
  // against a confirmed order, so the chance of an item being on the shelf
  // falls away as its price rises. Without this the simulated godown holds
  // several crores of chain blocks nobody keeps in stock.
  const weightFor = (rate) => (rate < 5000 ? 1 : rate < 25000 ? 0.45 : rate < 100000 ? 0.12 : 0.03);
  const stocked = items.filter(
    (i) => hash(i.code) < stockedFraction * weightFor(Number(i.list_rate) || 0)
  );
  const seedPath = path.join(config.root, 'data', 'tally-seed.json');
  fs.writeFileSync(
    seedPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), items: stocked }, null, 0)
  );
  return { written: true, path: seedPath, catalogue: items.length, stocked: stocked.length };
}
