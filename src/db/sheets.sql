-- ============================================================================
-- The Google Sheet as the store for everything Tally does not hold
-- ============================================================================
-- Two sources of truth, and only two: Tally owns ledgers, stock, bills and
-- vouchers; the Sheet owns quotations, orders, dispatches, invoices and the
-- audit trail. This local database owns nothing. It is a cache, and the test
-- of that claim is `npm run db:reset` followed by a boot: everything must come
-- back from the sheet.
--
-- These tables are the only exception. They are bookkeeping ABOUT the sync and
-- are deliberately not mirrored anywhere, because a queue of unsent writes is
-- meaningless on a different machine.

-- --- The outbox -------------------------------------------------------------
-- Every mirrored write lands here first and is pushed after the fact. That
-- ordering is the whole point: the sheet being unreachable must never be able
-- to fail a quotation someone is saving in front of a customer. The write is
-- committed locally, the row queues, and the drain catches up when Google is
-- answering again.
--
-- Queued by (entity, entity_id) rather than by change, so ten edits to one
-- order collapse into one push carrying its current state. There is no value
-- in replaying intermediate versions of a row into a spreadsheet.
CREATE TABLE IF NOT EXISTS sheet_outbox (
  id         INTEGER PRIMARY KEY,
  entity     TEXT NOT NULL,              -- a key from src/sheets/tabs.js
  entity_id  INTEGER NOT NULL,
  op         TEXT NOT NULL DEFAULT 'upsert',  -- upsert|delete
  -- An ISO instant, not SQLite's datetime('now'), which is UTC with no zone
  -- marker on it. The screens render these in local time, and an unmarked UTC
  -- string reads as five and a half hours in the past from Indore.
  queued_at  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE (entity, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_outbox_queued ON sheet_outbox(queued_at);

-- --- Sync runs --------------------------------------------------------------
-- The same shape as sync_runs for Tally, on purpose. "When did data last move,
-- which way, and did it work" is one question, and it should not have two
-- differently-shaped answers depending on which system you are asking about.
CREATE TABLE IF NOT EXISTS sheet_runs (
  id          INTEGER PRIMARY KEY,
  direction   TEXT NOT NULL,             -- pull|push
  trigger     TEXT NOT NULL,             -- boot|scheduled|manual|write
  status      TEXT NOT NULL,             -- ok|partial|failed
  rows_in     INTEGER NOT NULL DEFAULT 0,
  rows_out    INTEGER NOT NULL DEFAULT 0,
  detail      TEXT,                      -- JSON: per-tab counts
  error       TEXT,
  started_at  TEXT NOT NULL,             -- ISO instants, see queued_at above
  finished_at TEXT NOT NULL,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sheet_runs_dir ON sheet_runs(direction, finished_at);
