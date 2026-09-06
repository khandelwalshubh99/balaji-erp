# Pushing purchase orders in from Gmail

Your Apps Script already finds POs in Gmail and writes them to a sheet with a
Drive link. This adds one step to that script: after it writes the row, it also
POSTs the PO to the ERP, which records it as an order and puts it in the
**Items not entered** queue.

Direction matters. The script pushes; the ERP never reads your sheet. That
means no Google credentials stored here, no polling, and your sheet stays
private rather than being published to a public CSV URL.

## 1. Set a token on the ERP

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put it in `.env` as `INGEST_TOKEN=...` and restart. **With no token set the
endpoint is off** — it fails closed, because an open endpoint that creates
orders is worse than no endpoint at all.

## 2. Make the ERP reachable from Google

Apps Script runs on Google's servers, so it has to be able to reach the machine
this runs on. `http://localhost:4000` will not work from there. You need either
a port forward to that machine, a tunnel, or the ERP on a box with a public
name. This is the one genuinely fiddly part of the setup.

If that is not practical, skip this and export the sheet periodically instead —
the same duplicate checking applies whichever way the data arrives.

## 3. Add this to your Apps Script

```javascript
const ERP_URL   = 'https://your-erp-host/api/ingest/purchase-order';
const ERP_TOKEN = 'the INGEST_TOKEN value';

/**
 * Push one purchase order to the ERP.
 * Safe to call repeatedly: the ERP keys on sourceRef and answers
 * {status:'duplicate'} rather than creating a second order.
 */
function pushPoToErp(po) {
  const res = UrlFetchApp.fetch(ERP_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ERP_TOKEN },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      sourceRef:    po.gmailMessageId,   // REQUIRED - this is what stops duplicates
      customerName: po.customerName,
      poNumber:     po.poNumber,
      poDate:       po.poDate,           // YYYY-MM-DD, or anything Date can read
      documentUrl:  po.driveLink,
      receivedAt:   po.receivedDate,
      notes:        po.subject
    })
  });

  const out = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) {
    Logger.log('ERP rejected %s: %s', po.poNumber, out.error);
    return null;
  }
  if (out.warnings && out.warnings.length) Logger.log(out.warnings.join(' | '));
  return out;               // { status: 'created'|'duplicate', orderNumber, ... }
}
```

Call it wherever your script currently appends the sheet row, then write
`out.orderNumber` into a column so the sheet shows what became of each PO.

### Fields

| Field | Required | Notes |
| --- | --- | --- |
| `sourceRef` | **yes** | Gmail message id or Drive file id. The duplicate key — never reuse one across different POs. |
| `customerName` | **yes** | As written on the PO. Matched to a Tally ledger; unmatched ones are flagged, not dropped. |
| `poNumber` | no | Their PO number. |
| `poDate` | no | `YYYY-MM-DD`, or anything JavaScript's `Date` parses. |
| `documentUrl` | no | The Drive link. Shown on the order so whoever keys the items can open it. |
| `receivedAt` | no | Defaults to today. |
| `notes` | no | The email subject is a good default. |

Check it works before wiring it into the loop:

```bash
curl -s -X POST https://your-erp-host/api/ingest/ping -H "Authorization: Bearer $INGEST_TOKEN"
```

## What happens to a pushed PO

It becomes an order straight away, with the document linked and **no line
items** — because the items are inside the PDF, and this deliberately does not
try to guess them. A parser that reads PO layouts correctly 85% of the time is
worse than none, since someone has to check all of it to find the 15%.

So the order lands in **Items not entered** on the Orders screen. Opening it
shows the Drive link at the top and a catalogue search underneath: search the
12,261 SKUs, add each line, save. From that point it is an ordinary order.

## How duplicates are handled

| Signal | Verdict |
| --- | --- |
| Same `sourceRef` | Conclusive. Refused, and the script gets `{status:'duplicate'}` with a 200 so it does not keep retrying. Backed by a unique index, so two simultaneous calls cannot both win. |
| Same PO number, same customer | Reported as a warning. The order is still created, because a customer re-issuing a PO under the same number as an amendment is normal and a script cannot tell the difference. |
| Same customer and value within 7 days | Reported as a warning. |

Warnings come back in the response so your script can log them, and the flagged
orders are visible on the Orders screen.

## Security

- The token is compared in constant time, and the endpoint is off unless one is set.
- Only `http`/`https` document links are stored.
- Every accepted and rejected call is logged with the caller's IP.
- The endpoint can only create header-only orders. It cannot price anything, cannot touch Tally, and cannot dispatch.
