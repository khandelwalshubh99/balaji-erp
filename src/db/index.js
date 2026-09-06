import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { hashPassword } from '../lib/password.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Applied in order on every boot. Each file must be idempotent (CREATE TABLE
// IF NOT EXISTS), so starting the app is always safe regardless of which
// phases were present last time.
for (const file of ['schema.sql', 'phase2.sql']) {
  db.exec(fs.readFileSync(path.join(config.root, 'src', 'db', file), 'utf8'));
}

/** Columns added after a table already existed in someone's database. */
function addColumn(table, column, declaration) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}
addColumn('quotations', 'quote_date', 'TEXT');
addColumn('quotation_lines', 'brand', 'TEXT');
addColumn('quotation_lines', 'hsn', 'TEXT');
addColumn('quotation_lines', 'remarks', 'TEXT');
addColumn('orders', 'subtotal', 'REAL DEFAULT 0');
addColumn('orders', 'tax_amount', 'REAL DEFAULT 0');
addColumn('orders', 'total', 'REAL DEFAULT 0');
addColumn('orders', 'source', "TEXT NOT NULL DEFAULT 'manual'");
addColumn('orders', 'source_ref', 'TEXT');
addColumn('orders', 'document_url', 'TEXT');
addColumn('order_lines', 'brand', 'TEXT');
addColumn('order_lines', 'hsn', 'TEXT');

/** Columns that were tried and are no longer used. */
function dropColumn(table, column) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (has) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}
dropColumn('quotations', 'valid_until_pinned');

// Indexes over migrated columns, created after the columns exist. Putting
// these in the .sql alongside the tables breaks any database that predates
// the column.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_source_ref
    ON orders(source_ref) WHERE source_ref IS NOT NULL;
  -- Not unique: a customer can legitimately re-issue a PO under the same
  -- number as an amendment, so same-number orders are surfaced for a decision
  -- rather than blocked.
  CREATE INDEX IF NOT EXISTS idx_orders_po_number ON orders(customer_po_number);
`);

/**
 * Seed the two owner accounts described in Phase 1 ("likely just you and your
 * father, since it contains receivables"). The other three roles exist in the
 * schema for Phase 2 but have no users until the departments come on.
 */
export function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return [];
  const insert = db.prepare(
    'INSERT INTO users (username, display_name, role, password_hash) VALUES (?, ?, ?, ?)'
  );
  const seeded = [
    ['shubh', 'Shubh Khandelwal', 'owner', 'balaji123'],
    ['rajesh', 'Balaji Enterprises (Owner)', 'owner', 'balaji123'],
  ];
  const tx = db.transaction(() => {
    for (const [u, n, r, p] of seeded) insert.run(u, n, r, hashPassword(p));
  });
  tx();
  return seeded.map(([u, , , p]) => ({ username: u, password: p }));
}
