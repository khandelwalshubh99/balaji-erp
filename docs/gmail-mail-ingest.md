# Logging Gmail into the ERP

One Apps Script sweeps the mailbox every ten minutes and pushes each message to
the ERP. The ERP threads it, decides whether it is an order or an enquiry, and
gives it a number: a purchase order becomes an order with a **BE/SO/…** number,
an enquiry becomes a draft quotation with a **BE/Q/…** number, and anything the
rules cannot call gets no number and waits for you on the Mail screen.

Direction matters. The script pushes; the ERP never reads your mailbox. No
Google credentials are stored here.

This replaces the older purchase-order scrape in `gmail-po-ingest.md`. That
endpoint still works, so nothing breaks while you switch over.

The sheet this script writes its log into is also **the ERP's store** — see
[`sheets-store.md`](sheets-store.md). Two directions, one spreadsheet: the sweep
pushes mail in and logs what happened, and the ERP reads and writes its own tabs
over a separate Apps Script web app. Neither touches the other's tabs, and the
web app refuses `Order Log`, `Inquiry Log` and `Needs Review` outright.

---

## What "one thread" means here

Gmail threads by reply chain. That is not the threading this needs.

A customer sends an enquiry in September, gets a quotation, and in October
starts a **brand new mail** with their purchase order attached. Gmail calls
those two conversations. The business calls them one. So a thread here is keyed
on:

```
   (who they are)  +  (the reference THEY wrote in the subject)
```

and a Gmail conversation is only one of the ways messages arrive into it. All of
it — the enquiry, your quotation, their PO, the delivery chase, the payment
advice — sits on one record carrying one BE/Q number and one BE/SO number.

Two rules keep that safe rather than merely clever:

**A reference is never a key on its own.** Two customers both writing "PO 1234"
is not a coincidence, it is Tuesday. The customer is always part of the key, and
the database enforces it with a unique index rather than trusting the code.

**An unknown sender is never keyed on a free-mail domain.** `gmail.com` is not a
company. Those senders key on the whole address, so two unrelated people on
Gmail can never collapse into one another.

### How a mail finds its thread

Strongest signal first. Each step is a statement about the mail, not a
similarity score:

| | Signal | Why it ranks there |
| --- | --- | --- |
| 1 | It quotes one of **our** numbers — `BE/SO/2627/0031` | Conclusive. That is the record, by name. |
| 2 | It carries **their** reference — `PO No. 4500123456` | A deliberate statement of what the mail is about, which is why it outranks the Gmail chain: a customer replying to a month-old chain with a fresh PO number means a fresh order, and following the chain would bury it in the old one. |
| 3 | It is a reply in a Gmail conversation already logged | Followed to whichever record that conversation last touched. |
| 4 | Nothing to go on | A thread of its own. |

A reference is only ever taken from a **label followed by a number** in the
subject — `PO No. 4500123456`, `RFQ: ABC/25-26/117`. A bare number is not a
reference, dates are rejected, and the body is never used for threading: a PO
mail quotes your quotation number, their last order and an invoice from
May, and picking among those is guesswork.

---

## What gets a number, and what does not

The classifier scores each mail against two vocabularies. A subject hit counts
double — what a mail is about is said in the subject, while a body carries the
last four mails quoted underneath it.

It only files a mail when one side clears a floor **and** beats the other by a
margin. Otherwise it refuses, and refusing is a normal outcome, not an error:

| Mail | Verdict |
| --- | --- |
| "Purchase Order No. 4500123456" + `PO_4500123456.pdf` | **Order** → `BE/SO/…` |
| "Enquiry for pneumatic fittings — RFQ 887766" | **Enquiry** → `BE/Q/…` |
| "Purchase Order against RFQ 887766", "kindly supply as per your quotation" | **Order.** Enquiry words pointing *backwards* at an enquiry do not count as making one. |
| "Requirement" / "Need some items urgently" | **Not classified.** Waits for you. |
| Out-of-office, bounces, anything with `List-Unsubscribe` | **Set aside.** Logged with the reason, never dropped. |
| Anything **we** sent | Logged on the thread, never classified. Our own quotation email contains every enquiry phrase there is. |

An unclassified mail costs you ten seconds in a queue. A mail filed as the wrong
kind mints a number in the wrong sequence against the wrong customer, and is
found out weeks later by whoever is chasing the payment. The thresholds are set
accordingly.

**The server classifies, not the script.** The script sends its own reading
along, and a disagreement is reported as a warning — but the server's verdict is
what acts. Rules that have to hold for a mail arriving today and the same mail
re-pushed next month cannot live in two places.

---

## Setting it up

### 1. A token on the ERP

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

In `.env`:

```
INGEST_TOKEN=the-value-you-just-generated
MAIL_OWN_DOMAINS=rbalajient.com
MAIL_OWN_ADDRESSES=rbalajient1@gmail.com,rbalajient@rediffmail.com
```

**`MAIL_OWN_ADDRESSES` is not optional padding.** The rediffmail account
forwards into sales@, which makes `rediffmail.com` look like it belongs in
`MAIL_OWN_DOMAINS` — and putting it there would mark every customer on
rediffmail as us. Mail from us is never classified and never numbered, so a
large share of orders would simply stop appearing, with nothing in any log to
say why. The ERP refuses a shared provider in `MAIL_OWN_DOMAINS` and prints a
warning at startup; list the individual address here instead.

`MAIL_OWN_DOMAINS` is how the ERP tells your mail from theirs. It matters more
than it looks, because sales@ is a consolidation inbox: mail forwarded in from
accounts@ or from the rediffmail account arrives with **your own domain in the
From line** while being plainly incoming. The script therefore also sends which
Gmail folder it found each message in, and that is what actually decides — a
message in Sent is ours, a message in the Inbox is not, whatever the From line
says. When a forward turns out to come from one of your own addresses, the ERP
reads the original sender out of the quoted header block and says so on the
thread. **With no
`INGEST_TOKEN` the endpoint is off** — it fails closed, because an open endpoint
that creates orders is worse than no endpoint at all.

### 2. Make the ERP reachable from Google

Apps Script runs on Google's servers, so `http://localhost:4000` will not work
from there. You need a port forward, a tunnel, or the ERP on a box with a public
name. This is the one genuinely fiddly part.

### 3. The script

Open <https://script.google.com>, new project, paste in
[`scripts/erp-mail-sweep.gs`](../scripts/erp-mail-sweep.gs), and set the
values at the top:

```javascript
const CONFIG = {
  ERP_URL:   'https://your-erp-host',
  ERP_TOKEN: 'the INGEST_TOKEN value',
  QUERY:     '(in:inbox OR in:sent) -in:chats -category:promotions -category:social',
  BACKFILL_DAYS: 7,
  DRIVE_FOLDER_ID: '',      // optional: a folder to copy PO pdfs into
};
```

Then **switch on the Gmail advanced service**: in the editor, *Services* → add
**Gmail API**. Do not skip this. GmailApp cannot read message headers at all, so
without it the script cannot see `List-Unsubscribe` or `Auto-Submitted`, and a
marketing mail reading "best rates — request your quotation today" is
indistinguishable from a customer enquiry. It will be caught by its sender
address in most cases, but the header is the reliable signal. `setup()` reports
whether the service is on.

Then run **`setup()`** once. It checks the connection, creates the two labels,
and installs a ten-minute trigger. The first run reaches back seven days; every
run after that picks up from where the last one finished.

`DRIVE_FOLDER_ID` is worth setting. With it, the PO pdf is copied to Drive and
the order links straight to it, so whoever keys the items can open the document
from the order screen.

Two other functions are there when you need them:

- **`resetWatermark()`** — re-read everything from scratch, clearing both
  labels. Safe at any time: the ERP answers "duplicate" for everything it
  already holds, so this only picks up what was missed. Use it after changing a
  rule.
- **`stop()`** — remove the trigger. The mail and labels stay.

### 4. Watch the first run

Apps Script → Executions shows the log. On the ERP, the **Mail** screen fills
up, and the server log prints a line per push:

```
[mail] 34 in from 66.102.x.x: 31 new, 3 already seen, 12 records raised, 0 failed
```

---

## Why it is safe to leave running

| | |
| --- | --- |
| **The same mail twice** | The Gmail message id is a unique index in the database. A repeat is answered `duplicate` and changes nothing, so a retry, an overlapping run, or a re-run of the backfill are all harmless. The label the script applies is the cheap path, not the guarantee. |
| **The same enquiry twice** | Quotations key on the message that raised them, uniquely indexed. One mail can never burn two quote numbers. |
| **The same PO twice** | Orders key the same way. A *different* mail with the same PO number and customer is created but reported as a warning, because a customer re-issuing a PO as an amendment is normal and no script can tell the difference. |
| **A half-written record** | Each message is one transaction: logged, threaded and numbered, or none of it. There is no state where an order exists but the mail that produced it does not. |
| **The ERP being down** | The whole batch is unreachable, so nothing is labelled and the watermark does not move. The sweep picks the window up again when the ERP is back. |
| **One mail the ERP refuses** | That message alone is labelled `ERP/Failed` and the watermark still advances. It will be refused identically next time, so retrying it every ten minutes forever would achieve nothing — the query skips `ERP/Failed`. Take the label off the thread to have another go. |

Only two labels are ever created, `ERP/Logged` and `ERP/Failed`. Stamping each
order's number onto its own thread is tempting and would be unusable within a
month: Gmail caps a mailbox at 10,000 labels and lists every one in the sidebar.
The ERP holds the mapping, and each mail on a thread links back to Gmail.

---

## The Mail screen

**Waiting on you** is the only queue that matters. A thread lands there for one
of two reasons, and the row says which:

**"Not classified as an order or an enquiry."** Three buttons: *This is an
order*, *This is an enquiry*, *Neither — set aside*. Picking one mints the
number there and then, so a spam mail never burns a BE/Q number in your
sequence.

**"Sender is not tied to a Tally ledger."** Tally holds no email addresses, so
the first mail from a new customer can only be matched by their display name.
Bind them once — the whole domain for a company, just the address for someone on
Gmail — and every mail from them afterwards is matched without being asked. The
screen will not offer to bind a free-mail domain; doing so would file thousands
of unrelated senders as one customer.

Binding also re-keys their existing threads and merges any that turn out to be
the same conversation. If two of them each carry a record of their own, they are
**left alone and both flagged** — merging would destroy an order, and which of
two orders is real is a question for you, not for a rule.

---

## What a pushed purchase order looks like

An order, with the document linked and **no line items** — because the items are
inside the PDF, and this deliberately does not guess them. A parser that reads
PO layouts correctly 85% of the time is worse than none, since someone still has
to check all of it to find the 15%.

So it lands in **Items not entered** on the Orders screen. Opening it shows the
Drive link at the top and a catalogue search underneath. From that point it is
an ordinary order.

---

## Checking it without Gmail

```bash
curl -s -X POST https://your-erp-host/api/ingest/mail \
  -H "Authorization: Bearer $INGEST_TOKEN" -H 'Content-Type: application/json' \
  -d '{"messages":[{
        "gmailMessageId":"test-1",
        "gmailThreadId":"test-t1",
        "from":"\"Sanghvi Industries\" <purchase@sanghvi.co.in>",
        "subject":"Purchase Order No. 4500123456",
        "bodyText":"Kindly supply the attached items.",
        "sentAt":"2026-09-06T09:00:00Z"
      }]}'
```

The full local pipeline — threading, merging, minting, binding — is covered by
`npm run mail:test`, which runs against a throwaway database and never touches
your own. `npm run mail:demo` boots the app on port 4100 against that same
sample data, which is the quickest way to see the Mail screen with something in
it.

### Fields

| Field | Required | Notes |
| --- | --- | --- |
| `gmailMessageId` | **yes** | The duplicate key. Never reuse one. |
| `gmailThreadId` | no | Gmail's conversation id. Used for threading when a mail carries no reference. |
| `from` | no | `Name <address>`. The address is what threads; the name only helps match a ledger. |
| `to`, `cc` | no | For a mail we sent, `to` is who the thread belongs to. |
| `subject` | no | Where the reference is read from. |
| `bodyText` | no | Plain text. Classified on, never threaded on. Stored to 20,000 characters. |
| `sentAt` | no | ISO instant. Defaults to now. |
| `direction` | no | `in` or `out`. Re-checked against `MAIL_OWN_DOMAINS`, which wins. |
| `attachments` | no | `[{name, mimeType, size, url}]`. Only `http`/`https` urls are stored. |
| `permalink` | no | Link back to the mail. |
| `headers` | no | `List-Unsubscribe`, `List-Id`, `Auto-Submitted`, `X-Autoreply` — how bulk mail and auto-replies are recognised. Absent unless the Gmail advanced service is on; the ERP then falls back to the sender address and subject. |
| `verdict` | no | What the script thought. Recorded; the server's own reading is what acts. |

Up to 100 messages per push. Each is recorded in its own transaction and gets
its own result, so one malformed mail cannot cost the other ninety-nine.

## Security

- The token is compared in constant time, and the endpoint is off unless one is set.
- Only `http`/`https` links are stored, for documents and attachments alike.
- Every accepted and rejected call is logged with the caller's IP.
- The endpoint can only log mail and create header-only orders and draft
  quotations. It cannot price anything, cannot touch Tally, and cannot dispatch.
