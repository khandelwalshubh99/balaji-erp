# The Google Sheet as the store

Two systems hold this business's data, and only two.

| | Holds | How the ERP treats it |
| --- | --- | --- |
| **TallyPrime** | Ledgers, stock, bills, vouchers | Reads it. Never writes. |
| **A Google Sheet** | Quotations, orders, dispatches, invoices, the audit trail | Reads it **and** writes it. |

This machine's `data/balaji.db` holds neither. It is a copy of both, and the
claim is testable:

```bash
npm run db:reset && npm start
```

Everything comes back. Tally re-syncs, the sheet is pulled, and the order book
is where it was. `npm run sheets:verify` runs exactly that sequence against a
throwaway database and checks every record, every id and every join.

If that ever stops being true, the sheet is a log rather than a store, and this
laptop is a single point of failure holding the order book.

---

## Why a sheet, and why this way round

The mail sweep pushes **into** the ERP. That is why
[`gmail-mail-ingest.md`](gmail-mail-ingest.md) needs a public https name and
calls the tunnel "the one genuinely fiddly part" — Apps Script runs on Google's
servers and cannot reach your `localhost`.

This is the other direction. The ERP calls **out** to script.google.com, which
any machine on office wifi can do. No tunnel, no port forward, no static IP, no
router configuration. Connecting the store is pasting two values into a screen.

It also means the ERP holds no Google credentials — no service-account key, no
OAuth token, nothing to leak. It holds a shared secret, the same class of thing
as `INGEST_TOKEN`, and Google's own authorisation stays inside the script under
the account that owns the sheet.

---

## Who owns which tab

The spreadsheet has two kinds of tab and they must not be confused.

**The mail sweep's** — `Order Log`, `Inquiry Log`, `Needs Review`. One row per
mail, written by `erp-mail-sweep.gs`. The ERP never writes these; the web app
refuses them outright, whatever it is asked. They are the independent record of
what was pushed, and they are what the ERP can be *reconciled against* rather
than merely compared to.

**The ERP's** — `Quotations`, `Quotation Lines`, `Orders`, `Order Lines`,
`Dispatches`, `Dispatch Lines`, `Invoices`, `Pipeline Events`. Created on first
push, and rewritten by the ERP as records change.

Add your own columns to the right of the ERP's tabs if they help — a "Chased on"
column, a note. They survive updates untouched. A sheet people annotate is a
sheet people read.

### Column one is `ID`, and it is load-bearing

It is the row's id inside the ERP, written out and read back exactly. It is what
makes a rebuilt database *identical* to the one it replaced rather than merely
similar: order lines still point at the same order, invoices at the same
dispatch, events at the same record. Change it or delete the column and the
joins break — the pull refuses such a row rather than guessing.

---

## Setting it up

### 1. Deploy the web app

Open the Apps Script project bound to your sheet — the same one holding
`erp-mail-sweep.gs` — and paste in
[`scripts/erp-sheet-api.gs`](../scripts/erp-sheet-api.gs).

Run **`SHEETAPI_setup()`** once. It mints a token, checks the sheet is reachable
and prints both. Copy the token.

Then **Deploy → New deployment → Web app**:

| | |
| --- | --- |
| Execute as | **Me** |
| Who has access | **Anyone** |

"Anyone" reads worse than it is. Without the token every request is refused, in
constant time, and the endpoint is off entirely until a token exists — it fails
closed, exactly as the ingest endpoint does. What "Anyone" actually buys is the
ability to call it without a Google login, which is the whole point.

Copy the deployment URL. It ends in **`/exec`**. The `/dev` URL beside it works
in a browser you are already signed into and returns a sign-in page to
everything else, which makes it look correct right up until the ERP uses it —
so the ERP refuses `/dev` at the point of pasting.

### 2. Connect the ERP

**Connection → Store — Google Sheet.** Paste the `/exec` URL and the token,
press **Test connection**, then **Save**. The test names the spreadsheet it
reached and lists its tabs, so a URL pointing at last year's copy is obvious
before it is saved rather than after.

### 3. First push

If the ERP already has records and the sheet is empty, press **Replace the sheet
from this machine**, or:

```bash
npm run sheets:push -- --all
```

It writes every ERP-owned tab from this machine's records. From then on, changes
go up on their own.

**Re-deploy after editing the script.** Apps Script serves the last *deployed*
version, not the last saved one. This is the most common reason a change appears
to do nothing.

---

## What happens when

| | |
| --- | --- |
| **A quotation is saved** | Written locally and committed, then queued and pushed. The push is after the fact on purpose: the sheet being unreachable must never fail a quotation someone is saving in front of a customer. |
| **The sheet is unreachable** | The change sits in the outbox. The Connection screen says how many and since when. It goes out on the next timer tick, or on the next boot. |
| **The app boots** | It reads the sheet **before** opening the port, and waits for it. Then it sends anything queued from last time. |
| **Every ten minutes** | Read, then send. That order matters: sending first would write this machine's view over a change another machine made two minutes ago. |
| **Two people edit one order** | The later save wins. This is not solved, and a spreadsheet cannot solve it. What *is* guaranteed is that the sync itself never loses work — only a person overwriting another person can. |

### Numbering, and the one thing that is refused

`BE/Q/2627/0007` is worked out by finding the highest number already issued this
financial year. That is correct exactly as long as this machine knows about
every quotation there is — and with a sheet connected, it may not: a colleague
may have raised one an hour ago.

So **with a sheet connected, the ERP will not mint a number until it has read
the sheet.** The Connection screen says *numbering: held*, and says why.
Everything else keeps working: Tally data, every screen, every existing record.

Refusing is a worse outcome than minting. It is a very much better one than
minting the same number twice, which is discovered weeks later by whoever is
chasing the payment, if at all.

The Gmail sweep sees this as a `503` rather than a `400`, so it labels nothing
and leaves its watermark where it is — those mails are swept again once the
sheet is back, instead of being marked failed for ever.

---

## What a pull will and will not do

**It will not delete a record.** A row missing from a spreadsheet does not mean
"deleted". It means a filter is on, a read was truncated, someone sorted with a
range selected — or, occasionally, that the row genuinely went. The app cannot
tell these apart, and deleting orders on that evidence is not a trade worth
making. Delete from the ERP, which queues the deletion explicitly.

**It will delete a line.** A quotation's lines are its contents, not records in
their own right: removing line 3 of five has to leave four lines. This is
confined to parents the lines tab actually mentions, so an order whose lines
have never been pushed keeps them.

**It will not rewrite an event.** `Pipeline Events` is append-only. Editing an
event after the fact is not a correction, it is a falsification of the audit
trail, so a pull only ever adds rows there.

**A row it cannot use is reported, not guessed at.** No id, or an id that is not
a number, and the row is skipped and counted on the Connection screen.

---

## Trying it without Google

```bash
npm run sheets:demo
```

Boots the app on <http://localhost:4200> with a **simulated sheet** behind it.

The simulation is the same trick as the fake TallyPrime, and for the same
reason: `src/sheets/mock-server.js` does not reimplement the protocol, it loads
`scripts/erp-sheet-api.gs` — the actual file you paste into Google — behind
shims for the four Google services it uses, and serves its own `doPost`. What is
simulated is Google, not the code. So the verification exercises the real
script, down to its row-deletion order and its refusal to touch the mail log.

```bash
npm run sheets:verify   # the destroy-and-restore test, against that script
npm run sheets:mock     # just the simulated sheet, to point something else at
```

---

## Commands

| | |
| --- | --- |
| `npm run sheets:pull` | Read the sheet into this machine now |
| `npm run sheets:push` | Send what is queued |
| `npm run sheets:push -- --all` | Replace every ERP-owned tab from this machine |
| `npm run sheets:verify` | The destroy-and-restore test |
| `npm run sheets:demo` | The app on 4200 against a simulated sheet |
| `npm run sheets:mock` | The simulated sheet on its own |

## Security

- The token is compared in constant time inside the script, and the endpoint is
  off entirely until one is set.
- `SHEETAPI_rollToken()` replaces it. Every ERP using the old one stops at once.
- A `GET` on the URL answers with a version string and nothing else — no data,
  no tab names — so you can check a deployment is live from a browser.
- The web app refuses to write the mail sweep's tabs, whatever it is asked.
- One writer at a time, enforced by an Apps Script lock, so two ERP instances
  draining at the same moment cannot interleave into duplicate rows.
