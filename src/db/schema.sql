-- ---------------------------------------------------------------------------
-- Balaji Enterprises ERP — local store
--
-- Phase 1 keeps a synced COPY of Tally data so the dashboard never hits Tally
-- on a page load. Tally remains the system of record; nothing here is
-- authoritative. Every tally_* table is safe to drop and re-sync.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL,             -- owner | accounts | sales | dispatch
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tally_ledgers (
  guid            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  parent          TEXT,
  is_customer     INTEGER NOT NULL DEFAULT 0,
  is_supplier     INTEGER NOT NULL DEFAULT 0,
  phone           TEXT,
  gstin           TEXT,
  state           TEXT,
  credit_period_days INTEGER DEFAULT 0,
  credit_limit    REAL DEFAULT 0,
  opening_balance REAL DEFAULT 0,
  closing_balance REAL DEFAULT 0,
  outstanding     REAL DEFAULT 0,
  synced_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledgers_name ON tally_ledgers(name);
CREATE INDEX IF NOT EXISTS idx_ledgers_customer ON tally_ledgers(is_customer);

CREATE TABLE IF NOT EXISTS tally_stock_items (
  guid           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  alias          TEXT,
  part_number    TEXT,
  category       TEXT,
  item_group     TEXT,
  base_units     TEXT,
  hsn            TEXT,
  gst_rate       REAL DEFAULT 0,
  reorder_level  REAL DEFAULT 0,
  standard_price REAL DEFAULT 0,
  closing_qty    REAL DEFAULT 0,
  closing_rate   REAL DEFAULT 0,
  closing_value  REAL DEFAULT 0,
  synced_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_name ON tally_stock_items(name);
CREATE INDEX IF NOT EXISTS idx_stock_category ON tally_stock_items(category);

CREATE TABLE IF NOT EXISTS tally_bills (
  bill_ref            TEXT NOT NULL,
  party_name          TEXT NOT NULL,
  bill_date           TEXT,
  due_date            TEXT,
  credit_period_days  INTEGER DEFAULT 0,
  opening_amount      REAL DEFAULT 0,
  amount              REAL DEFAULT 0,
  synced_at           TEXT NOT NULL,
  PRIMARY KEY (bill_ref, party_name)
);
CREATE INDEX IF NOT EXISTS idx_bills_party ON tally_bills(party_name);
CREATE INDEX IF NOT EXISTS idx_bills_date ON tally_bills(bill_date);

CREATE TABLE IF NOT EXISTS tally_vouchers (
  guid           TEXT PRIMARY KEY,
  voucher_type   TEXT,
  voucher_number TEXT,
  date           TEXT,
  party_name     TEXT,
  reference      TEXT,
  narration      TEXT,
  amount         REAL DEFAULT 0,
  line_count     INTEGER DEFAULT 0,
  synced_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vouchers_date ON tally_vouchers(date);
CREATE INDEX IF NOT EXISTS idx_vouchers_type ON tally_vouchers(voucher_type);
CREATE INDEX IF NOT EXISTS idx_vouchers_ref ON tally_vouchers(reference);

CREATE TABLE IF NOT EXISTS tally_voucher_lines (
  id            INTEGER PRIMARY KEY,
  voucher_guid  TEXT NOT NULL REFERENCES tally_vouchers(guid) ON DELETE CASCADE,
  item_name     TEXT,
  qty           REAL DEFAULT 0,
  units         TEXT,
  rate          REAL DEFAULT 0,
  amount        REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lines_voucher ON tally_voucher_lines(voucher_guid);
CREATE INDEX IF NOT EXISTS idx_lines_item ON tally_voucher_lines(item_name);

-- Every sync attempt is recorded, success or failure. This log is how you
-- decide whether the pipeline is trustworthy enough to build Phase 2 on.
CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,               -- running | ok | partial | failed
  trigger     TEXT NOT NULL,               -- boot | schedule | manual
  mode        TEXT NOT NULL,               -- simulated | live
  target      TEXT NOT NULL,
  duration_ms INTEGER,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS sync_datasets (
  id        INTEGER PRIMARY KEY,
  run_id    INTEGER NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  dataset   TEXT NOT NULL,
  status    TEXT NOT NULL,                 -- ok | failed
  records   INTEGER DEFAULT 0,
  duration_ms INTEGER,
  message   TEXT
);
CREATE INDEX IF NOT EXISTS idx_datasets_run ON sync_datasets(run_id);
