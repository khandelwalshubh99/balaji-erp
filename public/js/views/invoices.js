import { api, html, raw, card, kpi, money, rupees2, count, shortDate, dateTime, esc, emptyState, todayISO } from '../util.js';

export const title = 'Invoices';

const TONE = { unmatched: 'bad', overdue: 'bad', outstanding: 'accent', paid: 'ok' };

export async function render(el) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const id = params.get('id');
  if (id) return detail(el, Number(id));
  return list(el, params.get('status') || '');
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
async function list(el, status = '') {
  const { invoices, awaitingInvoice, summary } = await api('/invoices');

  el.innerHTML = html`
    <div class="grid cols-4" style="margin-bottom:14px">
      ${raw(kpi({
        // First tile, and it is not the money owed. A consignment that left
        // three weeks ago with no invoice against it is worse than an overdue
        // one: nothing is chasing it, because no clock has started.
        label: 'Gone, not invoiced',
        value: count(summary.awaitingInvoice),
        tone: summary.awaitingInvoice ? 'warn' : '',
        sub: summary.awaitingInvoice
          ? `${money(summary.awaitingValue)} · oldest ${count(summary.oldestUninvoicedDays)} days`
          : 'every consignment is invoiced',
      }))}
      ${raw(kpi({
        label: 'Outstanding',
        value: money(summary.outstandingValue),
        sub: `${count(summary.outstandingCount)} invoice(s), per Tally`,
      }))}
      ${raw(kpi({
        label: 'Overdue',
        value: money(summary.overdueValue),
        tone: summary.overdueValue ? 'bad' : '',
        sub: `${count(summary.overdueCount)} past their due date`,
      }))}
      ${raw(kpi({
        label: 'Not found in Tally',
        value: count(summary.unmatched),
        tone: summary.unmatched ? 'bad' : '',
        sub: 'recorded here, no matching bill',
      }))}
    </div>

    <div class="callout" style="margin-bottom:14px">
      <strong>Payment status is read from Tally every time this screen loads.</strong>
      Nothing about who has paid is stored here, so nothing here can be out of date — but it is only as
      fresh as the last sync. Invoice numbers are the ones raised in Tally; this app does not issue its own.
    </div>

    <div id="waiting"></div>
    <div style="height:14px"></div>

    <div class="toolbar">
      <input type="search" id="q" placeholder="Invoice number, order, customer or DN…" />
      <select id="status">
        <option value="">Every invoice</option>
        <option value="overdue">Overdue</option>
        <option value="outstanding">Outstanding, within terms</option>
        <option value="unmatched">Not found in Tally</option>
        <option value="paid">Paid</option>
      </select>
    </div>
    <div id="holder"></div>
  `;

  el.querySelector('#status').value = status;
  drawWaiting(el, awaitingInvoice);
  drawInvoices(el, status ? invoices.filter((i) => i.position.status === status) : invoices);

  let timer;
  const refresh = async () => {
    const r = await api(`/invoices?${new URLSearchParams({
      search: el.querySelector('#q').value,
      status: el.querySelector('#status').value,
    })}`);
    drawInvoices(el, r.invoices);
  };
  el.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 180); });
  el.querySelector('#status').addEventListener('change', refresh);
}

/** The work queue: consignments that have left and have no invoice. */
function drawWaiting(el, rows) {
  el.querySelector('#waiting').innerHTML = card(
    'Dispatched, not invoiced',
    rows.length
      ? `<div class="table-wrap" style="max-height:340px"><table>
          <thead><tr>
            <th>DN</th><th>Order</th><th>Customer</th><th>Left</th><th class="num">Days</th>
            <th class="num">Value</th><th>LR</th><th></th>
          </tr></thead>
          <tbody>${rows.map((d) => `<tr>
            <td class="mono nowrap">${esc(d.dispatch_number)}</td>
            <td class="mono faint nowrap">${esc(d.order_number)}</td>
            <td class="truncate">${esc(d.customer_name)}</td>
            <td class="dim nowrap">${shortDate(d.dispatched_at)}</td>
            <td class="num ${d.daysSinceDispatch > 7 ? 'bad' : d.daysSinceDispatch > 2 ? 'warn' : 'dim'}">${count(d.daysSinceDispatch)}</td>
            <td class="num">${money(d.value.total)}</td>
            <td class="mono faint">${esc(d.lr_number || '—')}</td>
            <td><button class="btn small" data-raise="${d.id}" data-value="${d.value.total}"
                        data-dn="${esc(d.dispatch_number)}" data-customer="${esc(d.customer_name)}">Record invoice</button></td>
          </tr>`).join('')}</tbody></table></div>`
      : emptyState('Nothing waiting. Every consignment that has gone out has an invoice against it.'),
    { flush: rows.length > 0, note: rows.length ? 'oldest first' : '' }
  );

  el.querySelectorAll('button[data-raise]').forEach((btn) =>
    btn.addEventListener('click', () => raiseDialog(el, btn.dataset))
  );
}

function drawInvoices(el, rows) {
  el.querySelector('#holder').innerHTML = card(
    'Invoices',
    rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr>
            <th>Invoice</th><th>Date</th><th>Customer</th><th>Order</th><th>DN</th>
            <th class="num">Raised for</th><th class="num">Outstanding</th><th>Position</th>
          </tr></thead>
          <tbody>${rows.map((i) => `<tr data-id="${i.id}" style="cursor:pointer">
            <td class="mono nowrap">${esc(i.invoice_number)}</td>
            <td class="dim nowrap">${shortDate(i.invoice_date)}</td>
            <td class="truncate">${esc(i.customer_name)}</td>
            <td class="mono faint nowrap">${esc(i.order_number)}</td>
            <td class="mono faint nowrap">${esc(i.dispatch_number || '—')}</td>
            <td class="num">${money(i.amount)}</td>
            <td class="num ${i.position.status === 'overdue' ? 'bad' : ''}">${
              i.position.outstanding === null ? '<span class="faint">—</span>' : money(i.position.outstanding)
            }</td>
            <td><span class="pill ${TONE[i.position.status] || ''}">${esc(i.position.label)}</span></td>
          </tr>`).join('')}</tbody></table></div>`
      : emptyState('No invoices recorded.'),
    { flush: true }
  );
  el.querySelectorAll('tr[data-id]').forEach((row) =>
    row.addEventListener('click', () => { location.hash = `#/invoices?id=${row.dataset.id}`; })
  );
}

/**
 * Recording an invoice is typing in a number from a document.
 *
 * Kept to three fields on purpose. There is nothing to design here — the
 * invoice already exists, in Tally, and this is the act of telling the ERP
 * which consignment it belongs to.
 */
function raiseDialog(el, { raise, value, dn, customer }) {
  const holder = document.createElement('div');
  holder.innerHTML = html`
    <div class="callout" style="margin:14px 0">
      <strong>Record the invoice for ${dn}</strong> — ${customer}.
      <div style="display:grid;grid-template-columns:1.4fr 1fr 1fr auto auto;gap:10px;align-items:end;margin-top:10px">
        <div class="field" style="margin:0">
          <label for="i-number">Invoice number, as raised in Tally</label>
          <input id="i-number" placeholder="BE/2627/0001" autocomplete="off" />
        </div>
        <div class="field" style="margin:0">
          <label for="i-date">Invoice date</label>
          <input type="date" id="i-date" value="${todayISO()}" />
        </div>
        <div class="field" style="margin:0">
          <label for="i-amount">Amount</label>
          <input id="i-amount" value="${Number(value).toFixed(2)}" />
        </div>
        <button class="btn primary" id="i-save">Record</button>
        <button class="btn" id="i-cancel">Cancel</button>
      </div>
      <p class="faint" style="font-size:11.5px;margin:8px 0 0">
        The amount is the consignment valued at the order rates plus GST. If the invoice says something
        different, the invoice is right.
      </p>
      <div id="i-error"></div>
    </div>`;
  el.querySelector('#waiting').after(holder);
  holder.querySelector('#i-number').focus();

  holder.querySelector('#i-cancel').addEventListener('click', () => holder.remove());
  holder.querySelector('#i-save').addEventListener('click', async () => {
    const btn = holder.querySelector('#i-save');
    btn.disabled = true;
    try {
      const inv = await api('/invoices', {
        method: 'POST',
        body: JSON.stringify({
          dispatchId: Number(raise),
          invoiceNumber: holder.querySelector('#i-number').value,
          invoiceDate: holder.querySelector('#i-date').value,
          amount: holder.querySelector('#i-amount').value,
        }),
      });
      location.hash = `#/invoices?id=${inv.id}`;
    } catch (e) {
      btn.disabled = false;
      holder.querySelector('#i-error').innerHTML = `<div class="callout warn" style="margin-top:10px">${esc(e.message)}</div>`;
    }
  });
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
async function detail(el, id) {
  el.innerHTML = '<div class="loading">Loading invoice…</div>';
  const i = await api(`/invoices/${id}`);
  const p = i.position;

  el.innerHTML = html`
    <div class="toolbar">
      <button class="btn small" id="back">← All invoices</button>
      <span class="pill mono">${i.invoice_number}</span>
      <span class="pill ${raw(TONE[p.status] || '')}">${p.label}</span>
      <a class="pill mono" href="#/orders?id=${raw(i.order_id)}">${i.order_number}</a>
      ${raw(i.dispatch_id ? `<a class="pill mono" href="#/dispatch?id=${i.dispatch_id}">${esc(i.dispatch_number)}</a>` : '')}
      <span style="flex:1"></span>
      <span id="savestate" class="faint" style="font-size:12px"></span>
      <button class="btn primary small" id="save">Save</button>
      <button class="btn small" id="remove">Remove</button>
    </div>

    ${raw(p.status === 'unmatched' ? unmatchedCallout(i) : '')}

    <div class="quote-grid">
      <div>
        ${raw(card('Payment position', paymentPanel(i), { note: 'read from Tally, never stored' }))}

        <div style="height:14px"></div>

        ${raw(card('History',
          i.events.length
            ? `<div class="totals">${i.events.map((e) => `<div class="row">
                 <span class="dim">${esc(e.note || e.to_stage)}</span>
                 <span class="faint">${esc(e.actor_name || 'system')} · ${dateTime(e.at)}</span>
               </div>`).join('')}</div>`
            : emptyState('Nothing recorded yet.')
        ))}
      </div>

      <div>
        ${raw(card('Invoice', `
          <div class="field">
            <label for="number">Invoice number</label>
            <input id="number" value="${esc(i.invoice_number)}" />
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="field" style="margin-bottom:0">
              <label for="date">Date</label>
              <input type="date" id="date" value="${esc(i.invoice_date || '')}" />
            </div>
            <div class="field" style="margin-bottom:0">
              <label for="amount">Amount</label>
              <input id="amount" value="${Number(i.amount).toFixed(2)}" />
            </div>
          </div>
          <p class="faint" style="font-size:11.5px;margin:10px 0 0">
            Changing the number unlinks the bill it was matched to and looks again — the old link
            would otherwise keep reporting somebody else's payments as this invoice's.
          </p>`))}

        <div style="height:14px"></div>

        ${raw(card('Consignment', `<div class="credit-panel">
          <div class="row"><span class="dim">Customer</span><span>${esc(i.customer_name)}</span></div>
          <div class="row"><span class="dim">Their PO</span><span class="mono">${esc(i.customer_po_number || '—')}</span></div>
          <div class="row"><span class="dim">Dispatch</span><span class="mono">${esc(i.dispatch_number || 'not linked')}</span></div>
          <div class="row"><span class="dim">LR</span><span class="mono">${esc(i.lr_number || '—')}</span></div>
          <div class="row"><span class="dim">Transporter</span><span>${esc(i.transporter || '—')}</span></div>
          <div class="row"><span class="dim">Left</span><span>${i.dispatched_at ? shortDate(i.dispatched_at) : '—'}</span></div>
          <div class="row"><span class="dim">Agreed terms</span><span>${i.payment_terms_days} days</span></div>
        </div>`))}
      </div>
    </div>
  `;

  el.querySelector('#back').addEventListener('click', () => { location.hash = '#/invoices'; });
  ['#number', '#date', '#amount'].forEach((sel) =>
    el.querySelector(sel).addEventListener('input', () => { el.querySelector('#savestate').textContent = 'Unsaved'; })
  );

  el.querySelector('#save').addEventListener('click', async () => {
    const btn = el.querySelector('#save');
    btn.disabled = true;
    try {
      await api(`/invoices/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          invoiceNumber: el.querySelector('#number').value,
          invoiceDate: el.querySelector('#date').value,
          amount: el.querySelector('#amount').value,
        }),
      });
      await detail(el, id);
    } catch (e) { btn.disabled = false; alert(e.message); }
  });

  el.querySelector('#remove').addEventListener('click', async () => {
    if (!window.confirm(`Remove ${i.invoice_number} from the ERP? The invoice in Tally is untouched; its consignment goes back to the "not invoiced" queue.`)) return;
    try {
      await api(`/invoices/${id}`, { method: 'DELETE' });
      location.hash = '#/invoices';
    } catch (e) { alert(e.message); }
  });

  el.querySelector('#rematch')?.addEventListener('click', async () => {
    const btn = el.querySelector('#rematch');
    btn.disabled = true;
    try {
      const out = await api(`/invoices/${id}/match`, { method: 'POST' });
      if (!out.matched) { btn.disabled = false; btn.textContent = 'Still no matching bill'; return; }
      await detail(el, id);
    } catch (e) { btn.disabled = false; alert(e.message); }
  });

  el.querySelectorAll('button[data-link]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!window.confirm(`Link ${i.invoice_number} to Tally bill ${btn.dataset.link}, which is against ${btn.dataset.party}? Only do this if that is the same company under a different ledger name.`)) return;
      try {
        await api(`/invoices/${id}/link`, { method: 'POST', body: JSON.stringify({ billRef: btn.dataset.link }) });
        await detail(el, id);
      } catch (e) { alert(e.message); }
    })
  );
}

/**
 * The unmatched case, spelled out.
 *
 * It says what the two possible causes are, because "no matching bill" on its
 * own reads as a software problem and is almost always a real one: the invoice
 * was never raised in Tally, or it was raised against a different ledger.
 */
function unmatchedCallout(i) {
  return `<div class="callout warn" style="margin-bottom:14px">
    <strong>No bill in Tally matches this invoice number for ${esc(i.customer_name)}.</strong>
    That means one of three things: the invoice has not actually been raised in Tally yet; it was raised
    against a different ledger; or Tally has not been synced since. Nothing is chasing this payment until
    it is linked, because the clock lives on the bill.
    <div class="toolbar" style="margin:10px 0 0">
      <button class="btn small" id="rematch">Look again</button>
    </div>
    ${i.candidates.length ? `
      <div style="margin-top:10px">
        <div class="dim" style="font-size:12.5px;margin-bottom:6px">
          A bill with this exact number does exist, against a different party. If that is the same company
          under another ledger name, link it — nothing here can tell, and a rule that guessed would sooner
          or later chase the wrong customer.
        </div>
        ${i.candidates.map((c) => `<div class="toolbar" style="margin:0 0 6px">
          <span class="mono">${esc(c.bill_ref)}</span>
          <span class="dim">${esc(c.party_name)}</span>
          <span class="faint">${esc(String(c.bill_date || ''))} · outstanding ${money(c.amount)}</span>
          <button class="btn small" data-link="${esc(c.bill_ref)}" data-party="${esc(c.party_name)}">Link to this bill</button>
        </div>`).join('')}
      </div>` : ''}
  </div>`;
}

function paymentPanel(i) {
  const p = i.position;
  if (p.status === 'unmatched') {
    return emptyState('No bill linked, so there is nothing to report. Tally holds the payment position, not this app.');
  }
  if (p.status === 'paid') {
    return `<div class="credit-panel">
      <div class="row"><span class="dim">Status</span><span class="ok">Paid in full</span></div>
      <div class="row"><span class="dim">Tally bill</span><span class="mono">${esc(i.tally_bill_ref)}</span></div>
      <div class="row"><span class="dim">Matched</span><span>${i.matched_at ? shortDate(i.matched_at) : '—'}</span></div>
    </div>
    <p class="faint" style="font-size:11.5px;margin:10px 0 0">
      ${esc(p.note || 'Tally reports nothing outstanding against this bill.')}
    </p>`;
  }
  const b = p.bill || {};
  const mismatch = p.mismatch
    ? `<div class="callout warn" style="margin-top:12px">
         <strong>This invoice and the bill it is linked to are for different amounts.</strong>
         Recorded here as ${esc(rupees2(p.mismatch.recorded))}; Tally's bill is
         ${esc(rupees2(p.mismatch.billed))}. Usually that means the wrong bill was linked — a reference
         one digit out can still be a real bill for the right customer, and then every figure above belongs
         to somebody else's consignment. It can also be legitimate, if one bill covers several dispatches.
         Worth a look either way.
       </div>`
    : '';
  return `<div class="credit-panel">
    <div class="row"><span class="dim">Tally bill</span><span class="mono">${esc(i.tally_bill_ref)}</span></div>
    <div class="row"><span class="dim">Bill date</span><span>${shortDate(b.bill_date)}</span></div>
    <div class="row"><span class="dim">Due</span><span class="${p.daysOverdue ? 'bad' : ''}">${shortDate(p.dueDate)}${
      p.daysOverdue ? ` · ${p.daysOverdue} days late` : ''
    }</span></div>
    <div class="row"><span class="dim">Billed</span><span>${rupees2(b.opening_amount || i.amount)}</span></div>
    <div class="row"><span class="dim">Received</span><span class="${p.paid ? 'ok' : 'faint'}">${p.paid ? rupees2(p.paid) : '—'}</span></div>
    <div class="row grand" style="border-top:2px solid var(--text);padding-top:8px;margin-top:4px">
      <span>Still owed</span><span class="${p.daysOverdue ? 'bad' : ''}">${rupees2(p.outstanding)}</span>
    </div>
  </div>
  ${mismatch}
  <p class="faint" style="font-size:11.5px;margin:10px 0 0">
    Every figure here is Tally's, read as this page loaded. If a cheque was receipted this morning it will
    show after the next sync.
  </p>`;
}
