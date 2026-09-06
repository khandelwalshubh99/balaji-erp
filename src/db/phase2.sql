-- ---------------------------------------------------------------------------
-- Phase 2 — shared order-state across departments
--
-- Unlike the tally_* tables, NOTHING here is a mirror. This is the app's own
-- record, and for the stages it covers it is the system of record. Tally does
-- not know about RFQs, quotations, LR numbers or who cleared what.
--
-- Pipeline:
--   RFQ Received -> Quotation Sent -> Order Received -> [Credit Check]
--     -> Picking -> Dispatched -> Invoiced -> Payment Due -> Closed
--
-- An order does NOT carry a single linear stage. One PO can ship in two lots,
-- each with its own LR, invoice and payment clock, so the order's stage is
-- derived from its lines and its dispatches.
-- ---------------------------------------------------------------------------

-- --- RFQ --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rfqs (
  id            INTEGER PRIMARY KEY,
  rfq_number    TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  customer_guid TEXT,                       -- tally_ledgers.guid once matched
  source        TEXT NOT NULL DEFAULT 'phone',  -- phone|whatsapp|email|portal|walk-in
  received_at   TEXT NOT NULL,
  required_by   TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open|quoted|dropped
  dropped_reason TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rfqs_status ON rfqs(status);
CREATE INDEX IF NOT EXISTS idx_rfqs_customer ON rfqs(customer_name);

CREATE TABLE IF NOT EXISTS rfq_lines (
  id        INTEGER PRIMARY KEY,
  rfq_id    INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  line_no   INTEGER NOT NULL,
  item_name TEXT NOT NULL,                  -- as the customer asked for it
  item_guid TEXT,                           -- tally_stock_items.guid once matched
  qty       REAL DEFAULT 0,
  units     TEXT,
  notes     TEXT
);
CREATE INDEX IF NOT EXISTS idx_rfq_lines_rfq ON rfq_lines(rfq_id);

-- --- Quotation (versioned) --------------------------------------------------
-- Revisions are the norm, not the exception. Each revision is its own row;
-- exactly one is current; an order locks to the version that was accepted, so
-- "which price did we agree" stops being a matter of memory.
CREATE TABLE IF NOT EXISTS quotations (
  id            INTEGER PRIMARY KEY,
  quote_number  TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  is_current    INTEGER NOT NULL DEFAULT 1,
  rfq_id        INTEGER REFERENCES rfqs(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_guid TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft|sent|accepted|lost|superseded
  -- The date the quotation is issued under, which is not the same thing as the
  -- row's created_at: a quote can be dated deliberately, and a revision is
  -- re-dated when it is issued.
  quote_date    TEXT,
  sent_at       TEXT,
  -- No flag records whether this was set by hand: under the "last edited wins"
  -- rule, an expiry that is not quote_date + 15 can only have got that way by
  -- being set after the date, so the value itself is the answer.
  valid_until   TEXT,
  lost_reason   TEXT,                       -- price|stock|delivery|no-response|other
  subtotal      REAL DEFAULT 0,
  tax_amount    REAL DEFAULT 0,
  total         REAL DEFAULT 0,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (quote_number, version)
);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotations(status);
CREATE INDEX IF NOT EXISTS idx_quotes_current ON quotations(quote_number, is_current);

CREATE TABLE IF NOT EXISTS quotation_lines (
  id            INTEGER PRIMARY KEY,
  quotation_id  INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL,
  item_name     TEXT NOT NULL,
  item_guid     TEXT,
  item_code     TEXT,                       -- key from the quotation catalogue
  qty           REAL NOT NULL DEFAULT 0,
  units         TEXT,
  list_rate     REAL DEFAULT 0,
  discount_pct  REAL DEFAULT 0,
  rate          REAL NOT NULL DEFAULT 0,    -- rate actually quoted
  gst_rate      REAL DEFAULT 0,
  amount        REAL NOT NULL DEFAULT 0,
  -- Snapshotted, not joined. A quotation is a record of what was sent; if the
  -- price list is re-imported next month the quote must still read the same.
  brand         TEXT,
  hsn           TEXT,
  remarks       TEXT
);
CREATE INDEX IF NOT EXISTS idx_quote_lines_quote ON quotation_lines(quotation_id);

-- --- Order ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY,
  order_number    TEXT NOT NULL UNIQUE,
  customer_po_number TEXT,
  po_date         TEXT,
  quotation_id    INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
  customer_name   TEXT NOT NULL,
  customer_guid   TEXT,
  payment_terms_days INTEGER DEFAULT 0,

  -- Credit evaluated at the moment the PO was recorded, and kept as a snapshot
  -- so it stays meaningful later. Reported, not enforced: dispatch is not
  -- blocked on it. Flipping to enforcement is a rule change, not a schema one.
  credit_status     TEXT DEFAULT 'unknown', -- within|over_limit|has_overdue|unknown
  credit_limit_at_order   REAL DEFAULT 0,
  outstanding_at_order    REAL DEFAULT 0,
  overdue_at_order        REAL DEFAULT 0,
  credit_note       TEXT,

  subtotal        REAL DEFAULT 0,
  tax_amount      REAL DEFAULT 0,
  total           REAL DEFAULT 0,

  status          TEXT NOT NULL DEFAULT 'open', -- open|part_dispatched|dispatched|closed|cancelled
  cancelled_reason TEXT,
  received_at     TEXT NOT NULL,
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_name);

CREATE TABLE IF NOT EXISTS order_lines (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no     INTEGER NOT NULL,
  item_name   TEXT NOT NULL,
  item_guid   TEXT,
  item_code   TEXT,
  qty_ordered REAL NOT NULL DEFAULT 0,
  units       TEXT,
  rate        REAL NOT NULL DEFAULT 0,
  gst_rate    REAL DEFAULT 0,
  amount      REAL NOT NULL DEFAULT 0,
  -- Snapshotted like quotation lines: what was ordered must keep reading the
  -- same after the next price list import.
  brand       TEXT,
  hsn         TEXT,
  notes       TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);

-- --- Dispatch ---------------------------------------------------------------
-- One order, many dispatches. What actually left the godown lives here, which
-- is what makes a short shipment recordable the moment it happens instead of
-- surfacing days later as a phone call.
CREATE TABLE IF NOT EXISTS dispatches (
  id              INTEGER PRIMARY KEY,
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  dispatch_number TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'picking', -- picking|packed|dispatched|delivered
  lr_number       TEXT,
  transporter     TEXT,
  lr_date         TEXT,
  freight_amount  REAL DEFAULT 0,
  packed_at       TEXT,
  dispatched_at   TEXT,
  delivered_at    TEXT,
  pod_received    INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dispatches_order ON dispatches(order_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_status ON dispatches(status);

CREATE TABLE IF NOT EXISTS dispatch_lines (
  id             INTEGER PRIMARY KEY,
  dispatch_id    INTEGER NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  order_line_id  INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  item_name      TEXT NOT NULL,
  qty_dispatched REAL NOT NULL DEFAULT 0,
  units          TEXT,
  substituted_with TEXT,                    -- when a different SKU actually went
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS idx_dispatch_lines_dispatch ON dispatch_lines(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_lines_orderline ON dispatch_lines(order_line_id);

-- --- Invoice & the payment clock -------------------------------------------
-- The app never runs its own payment clock. It holds the LINK from a dispatch
-- to a Tally bill, and the due date and outstanding are read from what Tally
-- says. An invoice that cannot be matched to a bill is a data-quality signal,
-- not something to paper over — hence tally_bill_ref being nullable and
-- surfaced in an unmatched queue.
CREATE TABLE IF NOT EXISTS invoices (
  id              INTEGER PRIMARY KEY,
  order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  dispatch_id     INTEGER REFERENCES dispatches(id) ON DELETE SET NULL,
  invoice_number  TEXT NOT NULL,
  invoice_date    TEXT,
  amount          REAL DEFAULT 0,
  tally_bill_ref  TEXT,                     -- tally_bills.bill_ref once matched
  matched_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (invoice_number, order_id)
);
CREATE INDEX IF NOT EXISTS idx_invoices_order ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_bill ON invoices(tally_bill_ref);

-- --- Audit trail ------------------------------------------------------------
-- "Who moved this, when" — the thing that replaces memory in a dispute.
CREATE TABLE IF NOT EXISTS pipeline_events (
  id          INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,                -- rfq|quotation|order|dispatch|invoice
  entity_id   INTEGER NOT NULL,
  order_id    INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  from_stage  TEXT,
  to_stage    TEXT NOT NULL,
  note        TEXT,
  actor_id    INTEGER REFERENCES users(id),
  actor_name  TEXT,
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON pipeline_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_order ON pipeline_events(order_id);

-- --- Catalogue imported from the quotation tool -----------------------------
-- The 12,000+ SKU list is keyed on its own code and matched to Tally stock
-- items separately, because the two lists will not agree on names. Anything
-- unmatched stays visible rather than silently quoting an item we cannot check
-- stock for.
CREATE TABLE IF NOT EXISTS catalogue_items (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  brand         TEXT,
  category      TEXT,
  sub_category  TEXT,
  units         TEXT,
  list_rate     REAL DEFAULT 0,
  gst_rate      REAL DEFAULT 0,
  hsn           TEXT,
  tally_guid    TEXT,                       -- null until matched
  match_method  TEXT,                       -- exact|part-number|manual|unmatched
  match_score   REAL,
  imported_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_catalogue_name ON catalogue_items(name);
CREATE INDEX IF NOT EXISTS idx_catalogue_brand ON catalogue_items(brand);
CREATE INDEX IF NOT EXISTS idx_catalogue_tally ON catalogue_items(tally_guid);
CREATE INDEX IF NOT EXISTS idx_catalogue_match ON catalogue_items(match_method);
