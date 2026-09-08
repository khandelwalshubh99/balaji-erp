-- ---------------------------------------------------------------------------
-- Mail log — Gmail, threaded by what the mail is ABOUT
--
-- Gmail already threads by reply chain. That is not the threading this needs.
-- A customer sends an enquiry, gets a quotation, then three weeks later starts
-- a BRAND NEW mail with their purchase order attached. Gmail calls those two
-- conversations; the business calls them one. So the thread key here is not
-- Gmail's, it is:
--
--     (who they are)  +  (the reference THEY used)
--
-- and a Gmail thread is merely one of the ways messages arrive into it.
--
-- Two rules make this safe rather than merely clever:
--
--   A reference is never a key on its own. Two customers both writing
--   "PO 1234" is not a coincidence, it is Tuesday. party_key is always part
--   of the key, which is why the unique index below spans both columns.
--
--   An unknown sender is never keyed on a free-mail domain. gmail.com is not
--   a company. Those threads key on the full address instead, so two unrelated
--   people on Gmail can never collapse into one another.
--
-- Every thread carries at most one order and at most one quotation, not a
-- polymorphic link, because the ordinary case is that it eventually has both:
-- the enquiry that produced BE/Q/2627/0007 is the same conversation as the
-- purchase order that became BE/SO/2627/0031.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mail_threads (
  id              INTEGER PRIMARY KEY,

  -- 'cust:<tally guid>' once the party is known, otherwise 'domain:<domain>'
  -- for a company domain or 'email:<address>' for a free-mail sender.
  party_key       TEXT NOT NULL,
  customer_name   TEXT,
  customer_guid   TEXT,

  -- Their reference, as extracted from the subject. customer_ref is the
  -- normalised form the key is built on; customer_ref_raw is what was actually
  -- written, kept so the screen shows their number the way they wrote it.
  customer_ref    TEXT,
  customer_ref_raw TEXT,

  subject         TEXT NOT NULL,

  kind            TEXT NOT NULL DEFAULT 'unclassified', -- order|inquiry|unclassified|ignored
  -- How the kind was arrived at, so a wrong record can be traced to the rule
  -- that made it rather than argued about.
  decided_by      TEXT,                     -- classifier|reference|human
  decided_at      TEXT,

  order_id        INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  quotation_id    INTEGER REFERENCES quotations(id) ON DELETE SET NULL,

  -- A thread needing review is one nothing was minted for, or one whose sender
  -- could not be tied to a Tally ledger. Both are questions for a person.
  needs_review    INTEGER NOT NULL DEFAULT 1,
  review_reason   TEXT,

  message_count   INTEGER NOT NULL DEFAULT 0,
  first_message_at TEXT,
  last_message_at  TEXT,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The guarantee the whole feature rests on: one party, one reference, one
-- thread. Enforced by the database, not by the code that happens to run first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_threads_ref
  ON mail_threads(party_key, customer_ref) WHERE customer_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mail_threads_party ON mail_threads(party_key);
CREATE INDEX IF NOT EXISTS idx_mail_threads_kind ON mail_threads(kind);
CREATE INDEX IF NOT EXISTS idx_mail_threads_review ON mail_threads(needs_review);
CREATE INDEX IF NOT EXISTS idx_mail_threads_order ON mail_threads(order_id);
CREATE INDEX IF NOT EXISTS idx_mail_threads_quote ON mail_threads(quotation_id);

-- A Gmail conversation is followed through mail_messages.gmail_thread_id
-- rather than a link table, and deliberately so. When a customer replies to a
-- three-week-old chain with a NEW purchase order number, the reference they
-- wrote wins over the chain they happened to hit reply on — so that mail opens
-- its own record, and the bare "when is it shipping?" that follows attaches to
-- whichever record that conversation most recently touched.

CREATE TABLE IF NOT EXISTS mail_messages (
  id              INTEGER PRIMARY KEY,
  thread_id       INTEGER NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,

  -- The duplicate key. A message pushed twice is answered, not recorded twice,
  -- and it is the unique index rather than a lookup that makes that true even
  -- if two pushes arrive at once.
  gmail_message_id TEXT NOT NULL UNIQUE,
  gmail_thread_id TEXT,
  rfc_message_id  TEXT,

  -- Our own outgoing mail is logged but never classified and never mints an
  -- id: our quotation email says "quotation" in every line of it, and reading
  -- that as a customer enquiry would invent a record out of our own reply.
  direction       TEXT NOT NULL DEFAULT 'in',   -- in|out

  from_name       TEXT,
  from_email      TEXT,
  to_emails       TEXT,
  cc_emails       TEXT,
  subject         TEXT,
  subject_clean   TEXT,                         -- Re:/Fwd: stripped
  snippet         TEXT,
  body_text       TEXT,
  sent_at         TEXT,

  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachments     TEXT,                         -- JSON array of {name,mimeType,size,url}
  permalink       TEXT,

  classified_as   TEXT,                         -- order|inquiry|unclassified|ignored
  order_score     REAL DEFAULT 0,
  inquiry_score   REAL DEFAULT 0,
  classify_reason TEXT,
  -- What the Apps Script thought, kept alongside what this server decided.
  -- The server's verdict is the one that acts; a disagreement is a signal that
  -- the script is out of date, and is visible instead of silent.
  script_verdict  TEXT,

  extracted_ref     TEXT,                       -- their reference, as found
  extracted_our_ref TEXT,                       -- BE/SO/… or BE/Q/… if quoted back

  ingested_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread ON mail_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_sent ON mail_messages(sent_at);
CREATE INDEX IF NOT EXISTS idx_mail_messages_from ON mail_messages(from_email);
CREATE INDEX IF NOT EXISTS idx_mail_messages_gthread ON mail_messages(gmail_thread_id);

-- Learned sender -> customer bindings.
--
-- Tally holds no email addresses, so the first mail from a new customer cannot
-- be tied to a ledger by anything except their display name. Rather than guess
-- from the domain, an unresolved sender is flagged once; a person binds it; and
-- every mail from that sender afterwards is resolved without being asked again.
CREATE TABLE IF NOT EXISTS mail_party_map (
  id            INTEGER PRIMARY KEY,
  scope         TEXT NOT NULL,                  -- domain|address
  value         TEXT NOT NULL,                  -- lowercased
  customer_name TEXT NOT NULL,
  customer_guid TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, value)
);
