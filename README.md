# Balaji Enterprises — Operations System

A self-hosted, Tally-connected dashboard, built to the phased plan in
`Balaji_Enterprises_Custom_ERP_Plan.docx`.

**Built so far: Phase 0, Phase 1, and Phase 2 up to Order Received.** The
RFQ → Quotation → Order → Dispatch → Invoice model is in the database;
Quotations and Orders have screens. Picking and dispatch is next — that is the
stage that stops a short shipment being discovered days later.

Right now it runs against a **simulated TallyPrime** so the whole thing can be
used and judged before anyone touches the office machine.

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
| `npm run db:reset` | Delete the local mirror. **Tally is not touched.** |
| `npm run catalogue:import -- <file.xlsx>` | Import a price list |
| `npm run catalogue:match` | Re-match the catalogue against Tally |

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

**The missing HSN matters later.** It is fine for quoting, but Phase 3 writes
GST invoices into Tally, and those need an HSN per line. Filling it in for
Taparia and Groz is a data job worth starting before Phase 3, not during it.

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
  sync/engine.js       scheduled pull; per-dataset transactions and logging
  routes/              auth.js, api.js
  tally/               see above
public/                no build step — plain ES modules, one CSS file
scripts/               tally-probe, sync-once, run-mock-tally, db-reset
```

Deliberate choices worth knowing about:

- **SQLite, no build step, no bundler.** This has to run unattended on an office
  PC for years. `npm start` and nothing else.
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
