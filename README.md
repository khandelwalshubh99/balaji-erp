# Balaji Enterprises — Operations System

A self-hosted, Tally-connected dashboard, built to the phased plan in
`Balaji_Enterprises_Custom_ERP_Plan.docx`.

**Built so far: Phase 0 and Phase 1.** Phase 2 (shared order-state across
Quotations / Accounts / Dispatch) is next and is where the actual payoff is.

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
  mock-data.js   645 SKUs, 65 customers, 139 open bills, 120 days of vouchers
```

The simulated dataset is deterministic (seeded by `MOCK_SEED`), sized and priced
like an industrial tools and MRO distributor: Taparia, Stanley, DeWalt, Groz,
Deneers and friends, Indore/Pithampur customer names, ~₹2.5 Cr of stock, ~₹1.8 Cr
of receivables, ~₹1 Cr of monthly sales.

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

**Overview** — stock value, receivables, overdue, pending dispatch, a 30-day
sales line, ageing, orders sitting too long, and items below reorder level.

**Stock** — all synced items, searchable by any combination of words (`taparia
plier`, `safety shoes uk 8`), filterable by category and stock level.

**Receivables** — ageing in 0-30 / 31-60 / 61-90 / 90+ buckets, by customer,
click through to bill-by-bill. Credit limits are read from the Tally ledger and
only *reported*; nothing is enforced until Phase 4.

**Orders** — pending vs dispatched. Read the warning on that screen: an order
counts as dispatched only because a delivery note in Tally quotes its
sales-order number. Inconsistent references make orders look pending forever.
This is inference, and Phase 2 exists to replace it.

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
