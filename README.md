# Balaji Enterprises — Operations System

A self-hosted, Tally-connected dashboard, built to the phased plan in
`Balaji_Enterprises_Custom_ERP_Plan.docx`.

**Built so far: Phase 0, Phase 1, and all of Phase 2.** The full
RFQ → Quotation → Order → Dispatch → Invoice chain has screens, and enquiries
and purchase orders arrive on their own from Gmail.

**The Tally connection is read-only, and that is now a decision rather than a
stage.** The original plan had a Phase 3 writing sales vouchers back into
Tally; that is not being built. Vouchers stay a job done in Tally by the people
who do it now. Every request this app sends is a `TALLYREQUEST > Export`, there
is no Import path in the codebase, and nothing here can create, alter or delete
anything inside Tally.

**Two systems hold the data, and only two.** Tally holds the ledgers, stock and
bills. A **Google Sheet** holds everything Tally does not — quotations, orders,
dispatches, invoices, the audit trail — written to by the ERP and by the Gmail
sweep. This machine's `data/balaji.db` is a copy of both and holds nothing of
its own, which is a claim you can check: `npm run db:reset && npm start` gives
you back the order book. See [docs/sheets-store.md](docs/sheets-store.md).

Right now it runs against a **simulated TallyPrime** so the whole thing can be
used and judged before anyone touches the office machine, and there is a
simulated sheet for the same reason.

---

## Run it

```bash
npm install
cp .env.example .env
npm start
```

Open <http://localhost:4000>. Seeded logins are `shubh` / `balaji123` and
`rajesh` / `balaji123` — **change these before this goes on the office network.**

The first boot creates `data/balaji.db`, starts the simulated Tally on port
9000, and syncs immediately. Every 20 minutes after that it syncs again.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Same, restarting on file changes |
| `npm run tally:probe` | Phase 0 connection check from the terminal |
| `npm run tally:probe -- stock` | Pull one dataset and print the first record |
| `npm run sync:once` | Run one full sync and exit (usable from cron) |
| `npm run tally:mock` | Run just the simulated Tally, e.g. to point another tool at it |
| `npm run db:reset` | Delete the local copy. **Neither Tally nor the sheet is touched.** |
| `npm run catalogue:import -- <file.xlsx>` | Import a price list |
| `npm run catalogue:match` | Re-match the catalogue against Tally |
| `npm run dispatch:test` | Run picking and dispatch end to end against a throwaway database |
| `npm run invoice:test` | Run invoicing and the payment clock against a throwaway database |
| `npm run mail:test` | Run the Gmail pipeline end to end against a throwaway database |
| `npm run mail:demo` | Boot the app on port 4100 against that sample mail |
| `npm run sheets:pull` | Read the Google Sheet into this machine now |
| `npm run sheets:push` | Send queued changes to the sheet |
| `npm run sheets:push -- --all` | Replace every ERP-owned tab from this machine |
| `npm run sheets:verify` | Push, destroy the database, pull, prove everything came back |
| `npm run sheets:demo` | Boot the app on port 4200 against a simulated sheet |

---

## How the Tally simulation works

This is the part worth understanding, because it determines how much rework the
real cutover costs.

`src/tally/mock-server.js` is **not** a fake data layer inside the app. It is a
real HTTP server that speaks TallyPrime's actual XML/HTTP protocol — the same
one the live Tally exposes under *Gateway of Tally → Exchange → Data
Synchronization*. It parses `<ENVELOPE>` requests, honours `SVCURRENTCOMPANY`,
`SVFROMDATE`/`SVTODATE`, returns Tally-shaped `<COLLECTION>` responses, refuses
unknown report IDs with `<LINEERROR>`, and answers `TALLYREQUEST=Import` with a
`<RESPONSE><CREATED>` block.

Which means the app has **one** Tally client, not two. The requests in
`src/tally/requests.js`, the transport in `src/tally/client.js` and the parsers
in `src/tally/parse.js` are the exact code that will run against your Tally.
The simulation is swapped out at the socket, not in the code.

```
src/tally/
  requests.js    XML requests (each ships its own TDL — nothing to install in Tally)
  client.js      HTTP transport + error classification    <- runs against both
  parse.js       UTF-16 decoding, "142 Nos", sign conventions
  mock-server.js a fake TallyPrime on port 9000           <- deleted at cutover
  mock-data.js   stocks the real catalogue; invents customers, bills, vouchers
```

The simulated dataset is deterministic (seeded by `MOCK_SEED`). Stock items are
the **real** catalogue once a price list has been imported — the fake Tally
stocks about 3,700 of the 12,261 SKUs, names them inconsistently and leaves the
part number blank on a fifth of them, deliberately, so the catalogue matcher is
tested against realistic name drift rather than tidy data. Customers, bills and
vouchers are invented: ~65 Indore/Pithampur names, ~₹3 Cr of stock, ~₹1.9 Cr of
receivables, ~₹1.1 Cr of monthly sales.

### Cutting over to the real Tally

1. On the Tally machine: TallyPrime running, the company loaded, and
   *Exchange → Data Synchronization* enabled on a fixed port (9000).
2. Give that machine a static local IP.
3. In `.env`:

   ```
   TALLY_MODE=live
   TALLY_HOST=192.168.1.x     # the Tally machine
   TALLY_PORT=9000
   TALLY_COMPANY=Balaji Enterprises   # must match the company name exactly
   ```

4. Restart, then open **Tally connection → Test connection**.

That is the whole cutover. No code changes. `mock-server.js` and `mock-data.js`
stop being loaded and can be deleted.

**What to check first when the real Tally is connected**, in this order:

- *Test connection* — does the company name match exactly?
- *XML console → Ledgers* — do closing balances have the sign you expect?
  Tally exports a debit as negative, which is why `parse.js` negates a
  customer's balance to get what they owe. If your data comes back the other
  way, that one line is where to fix it.
- *XML console → Bills receivable* — **this is the request most likely to need
  adjusting.** Bill collections behave differently depending on whether
  bill-wise details are maintained and how references were entered. If the
  receivables screen looks wrong, this is why.
- *XML console → Day book* — do delivery notes actually carry the sales-order
  number in their Reference field? The Orders screen depends on that.

---

## What each screen is, and is not

**Dashboard** — the commercial view: what was quoted against what was billed,
which brands moved, and who is worth the phone call this week. Every rupee on it
is a Tally sales voucher, so it reconciles with Tally and not with the order
book; the app's own `invoices` rows record that a tax invoice was raised, which
is a different question from what was billed.

*Quoted against billed* is the one ratio Tally cannot answer on its own, because
Tally has no idea a quotation exists. The quoted side therefore comes from
quotations raised in this app — current version only, drafts excluded, dated by
the date the customer sees. Until quoting moves onto this screen the ratio has
nothing to divide by, and the screen says so in as many words rather than
printing `0.00×` and letting somebody act on it.

*Tiers* score every customer 1–5 on three things over a rolling window —
**how many brands** they buy, **how often** they buy, and **what they are
worth** each month — and add the three up. Platinum through Bronze. The scoring
is **relative to the rest of the book**, not to a rupee figure in a config file:
absolute bands need a number nobody has agreed yet, and would go wrong the first
year the business grows. Ties are scored on the midpoint of the block they form,
because most of the book buys from one or two brands and a top-edge rule would
make the genuinely broad buyers indistinguishable from them.

*Segments* are the customer's **industry** — pharmaceuticals, chemical,
automobile, food and agro, and whatever else turns up next. Nothing computes
this and nothing can: Tally has nowhere to record what a customer makes, and its
ledger groups in this company are salesmen and territory (`SALUJA JI (DEBTORS)`,
`TRADERS - INDORE`), so the industry is the app's own record, set once per
customer from the *Segment* column of the customer table. The label is free text
behind a dropdown of what is already in use — a plain text box gives you
"Automobile", "automobile" and "Auto" as three industries inside a week, which
is exactly the failure that makes the field useless for grouping.

It answers the question tiers cannot: a tier says what one customer is worth,
a segment says whether a bad month is *this customer* or *the whole of pharma*.
Customers with nothing set are counted under **Unassigned** rather than dropped
— a breakdown that silently omits a third of the book looks complete and is not,
and the size of that bucket is the only honest measure of how far the
categorising has got.

Assignments live in `customer_segments`, which is a table of its own and not a
column on `tally_ledgers`: that table is a mirror and every sync deletes rows
out of it, so a segment stored there would survive until the next pull and then
quietly vanish. With a Google Sheet connected they also ride the store as a
**Customer Segments** tab, which is by far the fastest way to categorise sixty
customers — a column in a spreadsheet rather than sixty dropdowns.

Which is what the last two lists are for: **high-tier customers not billed** and
**not quoted** this month, ordered by what they are typically worth in a month,
so the size of the gap is on the row rather than in someone's head.

The window is selectable (3, 6 or 12 months) and so is the month, and both tiers
and segments are recomputed **as at the end of the month being shown** — looking
back at July shows the standing that was true in July, rather than re-judging it
with what happened afterwards.

**Quotations** *(Phase 2)* — the replacement for the standalone quotation tool.
Search the 12,261-SKU catalogue, see live Tally stock and **the rate this
customer was last actually charged** against every line, and copy the finished
quotation for email in the same format the old tool produced. Adds what that
tool could not hold: a customer, a quote number, and revisions. A quotation
that has been marked sent is locked — it is the record of what the customer was
given — and *Revise* creates the next version alongside it.

**Orders** *(Phase 2)* — the customer's purchase order, recorded once. Convert
an accepted quotation (rates carry across with the discount folded in) or enter
one directly. The credit position is **snapshotted as the order is taken** —
what their exposure looked like at that moment, which is what makes it
reviewable later; a live figure would quietly rewrite history every time a bill
was paid. Credit is reported, never blocking.

Order status is **derived from its dispatches**, not set by hand: open →
part dispatched → dispatched follows from how much of each line has actually
left. Nobody has to remember to mark an order part-shipped, which is the whole
point. An order that has shipped in part or full can no longer be edited or
cancelled — adjust the dispatch instead.

Purchase orders mostly arrive **straight from Gmail** — see **Mail** below.
They land in the **Items not entered** queue with the PO pdf linked, ready for
someone to key the items against the catalogue.

**Dispatch** *(Phase 2)* — picking, what actually left, and the LR.

A pick list starts from what is **outstanding**, prefilled, because the common
case is "send all of it" and the exceptional case should be changing one number
rather than building a list from nothing. Typing a short quantity says so
immediately, on the line, while the person is still standing at the rack: the
balance stays outstanding and comes straight back to the pick queue. A short
shipment noticed on the loading bay costs nothing; one noticed by the customer
costs the order, and that gap is the entire reason this stage exists.

Four states, and what they mean: **picking** (a list, nothing has moved),
**packed** (staged, still here), **dispatched** (it has left), **delivered**.
Only the last two count towards fulfilment, which is why a pick list can be
discarded without a trace and a dispatch cannot be un-sent. Once it has gone the
quantities are frozen — an interface that lets someone quietly edit them a week
later cannot be used to settle a dispute about a short delivery.

Three things worth knowing:

- **Two open pick lists never promise the same stock.** Quantities sitting in
  somebody else's list are shown as allocated and excluded from what this one
  may take. Without that, two people picking the same order are each shown the
  full outstanding quantity, both pick it, and the second lorry leaves with
  stock that is not there.
- **The LR is not required to mark something dispatched.** It usually arrives
  after the vehicle has. Requiring it gives two bad outcomes — a dispatch
  recorded late, or a placeholder typed in for ever — so it goes out without
  one and sits in an **Awaiting LR** queue until the receipt turns up.
- **A substitution names what actually went** while still answering the ordered
  line, so the order can still be shown as fulfilled and the customer's box
  still matches the record.

**Invoices** *(Phase 2)* — the link between a consignment and its Tally bill,
and nothing more than that.

**No payment clock runs here, and none ever will.** Whether a bill is paid,
part paid or overdue is asked of Tally each time the screen loads and never
stored. A local `paid` flag is wrong the moment somebody receipts a cheque in
Tally without telling anyone, and a dashboard that chases a customer who paid
last Tuesday costs more goodwill than the dashboard is worth.

**Invoice numbers are Tally's too.** The tax invoice is a statutory document
and its number belongs to Tally's GST sequence; a BE/INV series issued here
would be a second sequence disagreeing with the filed one — the kind of
disagreement discovered by a tax officer rather than by us. So the number is
typed in from the invoice that was raised, and the app then goes looking for
the bill.

Which makes **the match the whole job**, and three rules do it:

- **The party has to agree.** Matching on the reference alone links an invoice
  to a same-numbered bill belonging to somebody else. It does not throw, it does
  not look wrong on any screen, and it produces a payment chase addressed to the
  wrong company. A same-numbered bill against a different party is *offered* to
  a person to link by hand, never linked by a rule.
- **A bill that vanishes has been paid, not lost.** Tally stops returning a bill
  once it is settled in full. "Matched once, gone now" is therefore *paid*;
  "never matched" is *not found*. The two are indistinguishable if you only look
  at whether a bill is there today, which is why the match is timestamped.
- **Amounts that disagree are flagged.** A reference typed one digit out can
  still be a genuine bill for the right customer — the party rule passes, nothing
  throws, and every figure shown belongs to a different consignment. The amounts
  are the only thing that gives it away, so a material difference says so.

The first tile on the screen is **Gone, not invoiced** rather than the money
owed, because a consignment that left three weeks ago with no invoice is worse
than an overdue one: nothing is chasing it, since no clock has started.

**Mail** *(Phase 2)* — every mail in the account, threaded by what it is *about*
rather than by who replied to what, and given a number. A purchase order becomes
an order with a BE/SO number; an enquiry becomes a draft quotation with a BE/Q
number; anything the rules cannot call gets no number and waits in one queue.

The threading is the point. A customer enquires in September, gets a quotation,
and in October starts a **brand new mail** with their PO attached — Gmail calls
those two conversations, the business calls them one. So a thread is keyed on
*the customer plus the reference they wrote in the subject*, and a Gmail
conversation is only one of the ways messages arrive into it. The enquiry, the
quotation, the PO, the delivery chase and the payment advice sit on one record.

Two rules stop that being reckless. A reference never keys a thread on its own —
two customers both writing "PO 1234" is not a coincidence, it is Tuesday — and
an unknown sender is never keyed on a free-mail domain, because gmail.com is not
a company. Both are enforced by a unique index rather than by whichever code
happens to run first.

It refuses to guess, and refusing is a normal outcome rather than an error. An
unclassified mail costs ten seconds in a queue; a mail filed as the wrong kind
mints a number in the wrong sequence against the wrong customer, and is found
weeks later by whoever is chasing the payment.

The Apps Script that feeds it is in
[scripts/erp-mail-sweep.gs](scripts/erp-mail-sweep.gs); the setup, the
rules, and why it is safe to leave running are in
[docs/gmail-mail-ingest.md](docs/gmail-mail-ingest.md). `npm run mail:demo`
boots the app against sample mail if you want to see the screen with something
in it first.

**Catalogue** — all 12,261 price-list SKUs with their Tally match state. See
"The catalogue and the price list" below.

**Overview** — stock value, receivables, overdue, pending dispatch, a 30-day
sales line, ageing, orders sitting too long, and items below reorder level.

**Stock** — all synced items, searchable by any combination of words (`taparia
plier`, `safety shoes uk 8`), filterable by category and stock level.

**Receivables** — ageing in 0-30 / 31-60 / 61-90 / 90+ buckets, by customer,
click through to bill-by-bill. Credit limits are read from the Tally ledger and
only *reported*; nothing is enforced until Phase 4.

**Tally orders** — the Phase 1 inferred view: sales orders read straight out of
Tally, counted as dispatched only because a delivery note quotes the sales-order
number. Inconsistent references make orders look pending forever. It stays
useful for orders raised directly in Tally and for anything placed before this
system, but orders taken here live under **Orders**, where nothing is inferred.

**Tally connection** — Phase 0 lives here permanently: connection test, last
sync with per-dataset record counts, sync history, and an XML console that sends
the app's own requests and shows the raw reply.

### The honest limits of Phase 1

Straight from the plan, and still true of this build:

- It is a **mirror**, refreshed on a timer. It is minutes behind, deliberately.
- It does **not** reduce the "someone didn't know X" errors. It makes
  information faster to see. It does not stop a dispatch going out before
  accounts have cleared it. That is Phase 2.
- Nothing is written back to Tally. Tally remains the system of record.

---

## The catalogue and the price list

`npm run catalogue:import -- data/balaji-price-list-2026-09-01.xlsx`

Reads the price-list workbook with the same header guesses the existing
quotation tool uses, so the same file works in both. It adds normalisation that
tool does not do, and reports what it found:

| | |
| --- | --- |
| SKUs | 12,261 across 6 brands |
| Key | Part No — unique across every row, including across brands |
| Missing HSN | 3,976 — every Taparia and every Groz row |
| Odd GST | written three ways: `GST 18%`, `18`, `5% GST` |
| Zero price | 8 items |
| Category | derived from the description; ~91% land in a real one |

**The missing HSN is worth filling in anyway.** It does not block quoting, and
now that nothing is written back to Tally it blocks nothing at all — but an HSN
per line is what a GST invoice needs, and having it on the quotation is what
saves the person raising that invoice in Tally from looking it up again.

### Matching the catalogue to Tally

Two separately-maintained lists: the price list is keyed on the manufacturer's
part number, Tally items are named however whoever created them decided. The
matcher runs three passes, most trustworthy first, and records which one made
each match:

1. `exact` — Tally's part number equals the catalogue code
2. `code-in-name` — the code appears inside the Tally item's name
3. `name` — descriptions normalise to the same string
4. otherwise **left unmatched**, and listed

Two rules keep this honest. A Tally item can be claimed by only one catalogue
code, so two SKUs can never quietly read the same stock figure. And nothing is
matched on a similarity score — an unmatched item is still quotable, you just
do not get a live stock figure against it.

Against the simulated Tally this matches **99% of stocked items**. Re-run it any
time with `npm run catalogue:match`; a sync runs it automatically whenever stock
changes.

When the real Tally is connected, this match rate is the number to watch. A low
one means the two lists have drifted, not that the matcher is broken — the
Catalogue screen shows both directions of the gap.

---

## Shape of the code

```
src/
  config.js            all environment reading, in one place
  server.js            express app, boots the simulated Tally in simulated mode
  db/
    schema.sql         every tally_* table is a disposable mirror
    index.js           SQLite connection + user seeding
    queries.js         read models for the dashboard (never touches Tally)
  analytics/service.js quoted-vs-billed, brand sales, customer tiers, segments
  customers/service.js Tally's parties, plus the industry segment it cannot hold
  sync/engine.js       scheduled pull; per-dataset transactions and logging
  dispatch/service.js  picking, what left, the LR; order status derives from it
  invoices/service.js  the link to a Tally bill. No payment state is stored here
  routes/              auth.js, api.js, ingest.js
  tally/               see above
  sheets/
    tabs.js            what lives in which column, in ONE declaration, both ways
    client.js          the only thing that talks to the sheet; outbound only
    store.js           push, pull, the outbox, the scheduler
    state.js           has the sheet been read yet — the guard on numbering
    mock-server.js     runs the real .gs behind fake Google services
public/                no build step — plain ES modules, one CSS file
scripts/               tally-probe, sync-once, run-mock-tally, db-reset,
                       erp-mail-sweep.gs and erp-sheet-api.gs (paste into Google)
```

Deliberate choices worth knowing about:

- **SQLite, no build step, no bundler.** This has to run unattended on an office
  PC for years. `npm start` and nothing else.
- **The local database is a copy, never the record.** Tally and the sheet are
  the two stores. `npm run db:reset` is the test of that, not a disaster.
- **Every call to Google is outbound.** The mail sweep pushes in and needs a
  tunnel; the store reaches out and does not. That is why connecting the store
  is pasting two values into a screen rather than configuring a router.
- **Numbering refuses rather than risks a collision.** With a sheet connected
  and not yet read, no new BE/Q or BE/SO number is issued. Another machine may
  have issued the next one an hour ago, and one number reaching two customers
  is found out weeks later by whoever is chasing the payment.
- **Each sync dataset commits separately.** One bad dataset marks the run
  `partial` and the dashboard says so, instead of quietly serving stale numbers
  as if they were fresh.
- **Sessions are in memory.** Restarting the server signs everyone out; they log
  back in. Worth replacing with a persistent store when more than two people use
  this.
- **Roles exist in the schema** (`owner`, `accounts`, `sales`, `dispatch`) but
  only owner accounts are seeded, because Phase 1 shows receivables.

---

## Before Phase 2 can be built

These are business decisions, not technical ones, and the plan is right that
they have to be settled first:

1. **What "Accounts Cleared" means, in writing.** Full payment received, or
   approved credit terms? The whole pipeline hinges on this one definition.
2. **Who owns each handoff, by name.** The shared record is worth nothing if
   quotations still confirm orders over WhatsApp.
3. **Reorder points and credit limits, formalised.** Phase 4 cannot enforce what
   has not been decided.

---

## Deploying to the office

Run it on the Tally machine or any always-on PC on the same network:

```bash
PORT=4000 npm start
```

Then reach it from any browser on the network at `http://<that-machine>:4000`.
Before that happens: change both seeded passwords and set a real
`SESSION_SECRET` in `.env`. There is no HTTPS and no protection beyond the login
— this is built to live on the office LAN, not the internet.
