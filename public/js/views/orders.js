import { api, html, raw, card, kpi, money, rupees2, count, qty, shortDate, dateTime, esc, emptyState, todayISO } from '../util.js';

export const title = 'Orders';

const STATUS_TONE = {
  open: 'accent',
  part_dispatched: 'warn',
  dispatched: 'ok',
  closed: 'ok',
  cancelled: '',
};
const STATUS_LABEL = {
  open: 'Awaiting dispatch',
  part_dispatched: 'Part dispatched',
  dispatched: 'Dispatched',
  closed: 'Closed',
  cancelled: 'Cancelled',
};
const CREDIT_TONE = { within: 'ok', has_overdue: 'warn', over_limit: 'bad', unknown: '' };
const CREDIT_LABEL = {
  within: 'Within terms',
  has_overdue: 'Had overdue bills',
  over_limit: 'Over limit',
  unknown: 'Not checked',
};

export async function render(el) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const id = params.get('id');
  if (id === 'new') return composer(el, null, params.get('quotation'));
  if (id) return detail(el, Number(id));
  return list(el);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
async function list(el) {
  const { orders, summary } = await api('/orders');

  el.innerHTML = html`
    <div class="grid cols-4" style="margin-bottom:14px">
      ${raw(kpi({ label: 'Awaiting dispatch', value: count(summary.openCount), sub: `${money(summary.openValue)} of value` }))}
      ${raw(kpi({
        label: 'Flagged on credit',
        value: count(summary.flagged),
        tone: summary.flagged ? 'warn' : '',
        sub: 'open orders, over limit or overdue',
      }))}
      ${raw(kpi({
        label: 'Items not entered',
        value: count(summary.needsLines),
        tone: summary.needsLines ? 'warn' : '',
        sub: 'POs in from email, awaiting entry',
      }))}
      ${raw(kpi({
        label: 'Customer unmatched',
        value: count(summary.unmatchedCustomer),
        tone: summary.unmatchedCustomer ? 'bad' : '',
        sub: 'not tied to a Tally ledger',
      }))}
    </div>

    <div class="toolbar">
      <button class="btn primary" id="new">Record an order</button>
      <input type="search" id="q" placeholder="Order no, customer, or their PO number…" />
      <select id="status">
        <option value="">Any status</option>
        <option value="open">Awaiting dispatch</option>
        <option value="needs_lines">Items not entered</option>
        <option value="unmatched_customer">Customer unmatched</option>
        <option value="part_dispatched">Part dispatched</option>
        <option value="dispatched">Dispatched</option>
        <option value="cancelled">Cancelled</option>
      </select>
    </div>

    <div id="holder"></div>
  `;

  const draw = (rows) => {
    el.querySelector('#holder').innerHTML = card(
      'Orders',
      rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr>
              <th>Order</th><th>Their PO</th><th>Customer</th><th>Received</th>
              <th class="num">Lines</th><th class="num">Value</th><th>Credit then</th><th>Status</th>
            </tr></thead>
            <tbody>${rows
              .map((o) => `<tr data-id="${o.id}" style="cursor:pointer">
                <td class="mono nowrap">${esc(o.order_number)}</td>
                <td class="mono faint nowrap">${esc(o.customer_po_number || '—')}</td>
                <td class="truncate">${esc(o.customer_name)}</td>
                <td class="dim nowrap">${shortDate(o.received_at)}</td>
                <td class="num ${o.line_count ? 'dim' : 'warn'}">${o.line_count || '—'}</td>
                <td class="num">${money(o.total)}</td>
                <td><span class="pill ${CREDIT_TONE[o.credit_status] || ''}">${CREDIT_LABEL[o.credit_status] || o.credit_status}</span></td>
                <td><span class="pill ${STATUS_TONE[o.status] || ''}">${STATUS_LABEL[o.status] || o.status}</span>${
                  o.status === 'open' && !o.line_count ? ' <span class="pill warn">needs items</span>' : ''
                }${o.source !== 'manual' ? ` <span class="pill">${esc(o.source)}</span>` : ''}</td>
              </tr>`)
              .join('')}</tbody></table></div>`
        : emptyState('No orders recorded yet. “Record an order” starts one, or accept a quotation and convert it.'),
      { flush: true }
    );
    el.querySelectorAll('tr[data-id]').forEach((row) =>
      row.addEventListener('click', () => { location.hash = `#/orders?id=${row.dataset.id}`; })
    );
  };
  draw(orders);

  el.querySelector('#new').addEventListener('click', () => { location.hash = '#/orders?id=new'; });
  let timer;
  const refresh = async () => {
    const r = await api(`/orders?${new URLSearchParams({
      search: el.querySelector('#q').value,
      status: el.querySelector('#status').value,
    })}`);
    draw(r.orders);
  };
  el.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 200); });
  el.querySelector('#status').addEventListener('change', refresh);
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
function creditCard(credit, orderValue, { snapshot = null } = {}) {
  if (!credit) {
    return card('Credit position', '<div class="faint" style="font-size:12.5px">Pick a customer to see their position.</div>');
  }
  const after = credit.outstanding + orderValue;
  const over = credit.creditLimit > 0 && after > credit.creditLimit;
  return card('Credit position', `
    <div class="credit-panel">
      <div class="row"><span class="dim">Outstanding</span><span>${money(credit.outstanding)}</span></div>
      <div class="row"><span class="dim">Overdue</span><span class="${credit.overdue ? 'bad' : 'faint'}">${credit.overdue ? money(credit.overdue) : '—'}</span></div>
      <div class="row"><span class="dim">Credit limit</span><span>${credit.creditLimit ? money(credit.creditLimit) : 'none set'}</span></div>
      <div class="row"><span class="dim">Payment terms</span><span>${credit.creditPeriodDays} days</span></div>
      <div class="row" style="border-top:1px solid var(--border);padding-top:7px;margin-top:2px">
        <span class="dim">With this order</span><span id="c-after" class="${over ? 'bad' : ''}">${money(after)}</span>
      </div>
      <div id="c-after-flag">${
        over ? `<span class="pill bad">Takes them ${money(after - credit.creditLimit)} past their limit</span>` : ''
      }</div>
      ${snapshot ? `<div class="faint" style="font-size:11.5px;margin-top:6px;padding-top:7px;border-top:1px solid var(--border)">
          When this order was received: ${money(snapshot.outstanding_at_order)} outstanding against a
          ${snapshot.credit_limit_at_order ? money(snapshot.credit_limit_at_order) : 'n/a'} limit.
        </div>` : ''}
    </div>`, { note: 'from Tally' });
}


const INVOICE_TONE = { unmatched: 'bad', overdue: 'bad', outstanding: 'accent', paid: 'ok' };

/**
 * What has been billed against this order, and where the money is.
 *
 * The position on each row is Tally's, computed as the page loaded. Nothing
 * about payment is held in this database, so there is no version of this that
 * can be out of date by more than one sync.
 */
function invoiceCard(o) {
  const invoiced = (o.invoices || []).reduce((n, i) => n + (i.amount || 0), 0);
  const uninvoiced = o.dispatches.filter(
    (d) => ['dispatched', 'delivered'].includes(d.status) && !(o.invoices || []).some((i) => i.dispatch_id === d.id)
  );

  return card('Invoices',
    (o.invoices || []).length
      ? `<div class="table-wrap" style="max-height:none"><table>
          <thead><tr><th>Invoice</th><th>Date</th><th>DN</th><th class="num">Amount</th><th class="num">Owed</th><th>Position</th></tr></thead>
          <tbody>${o.invoices.map((i) => `<tr data-invoice="${i.id}" style="cursor:pointer">
            <td class="mono nowrap">${esc(i.invoice_number)}</td>
            <td class="dim nowrap">${shortDate(i.invoice_date)}</td>
            <td class="mono faint nowrap">${esc(i.dispatch_number || '—')}</td>
            <td class="num">${money(i.amount)}</td>
            <td class="num ${i.position.status === 'overdue' ? 'bad' : ''}">${
              i.position.outstanding === null ? '—' : money(i.position.outstanding)}</td>
            <td><span class="pill ${INVOICE_TONE[i.position.status] || ''}">${esc(i.position.label)}</span></td>
          </tr>`).join('')}</tbody></table></div>
          ${uninvoiced.length
            ? `<div class="callout warn" style="margin:12px 16px 16px">
                 ${uninvoiced.length} consignment${uninvoiced.length === 1 ? '' : 's'} on this order
                 ${uninvoiced.length === 1 ? 'has' : 'have'} gone out with no invoice against
                 ${uninvoiced.length === 1 ? 'it' : 'them'}. <a href="#/invoices">Record ${uninvoiced.length === 1 ? 'it' : 'them'}</a>.
               </div>`
            : ''}`
      : uninvoiced.length
        ? `<div class="callout warn" style="margin:0">
             <strong>Nothing has been invoiced yet</strong>, and ${uninvoiced.length}
             consignment${uninvoiced.length === 1 ? ' has' : 's have'} already gone out.
             Until an invoice is recorded and matched to its Tally bill, no payment clock is running on this order.
             <div style="margin-top:8px"><a href="#/invoices">Go to invoices</a></div>
           </div>`
        : emptyState('Nothing invoiced. Invoices are raised in Tally and recorded here once a consignment has gone.'),
    {
      flush: (o.invoices || []).length > 0,
      note: invoiced ? `${money(invoiced)} of ${money(o.total)} billed` : '',
    });
}

const DISPATCH_TONE = { picking: 'accent', packed: 'warn', dispatched: '', delivered: 'ok' };
const DISPATCH_LABEL = { picking: 'Picking', packed: 'Packed', dispatched: 'In transit', delivered: 'Delivered' };

/**
 * What has gone out against this order, and the way to send the rest.
 *
 * On the order screen rather than only on the dispatch screen because the
 * question "has this shipped?" is asked while looking at the order, and an
 * answer that requires navigating somewhere else is an answer people guess at.
 */
function dispatchCard(o) {
  const canPick = o.status !== 'cancelled' && o.lines.length > 0
    && o.lines.some((l) => l.qty_ordered - l.qty_dispatched > 0);

  return card('Dispatches',
    o.dispatches.length
      ? `<div class="table-wrap" style="max-height:none"><table>
          <thead><tr><th>DN</th><th>LR</th><th>Transporter</th><th>Left</th><th>Status</th></tr></thead>
          <tbody>${o.dispatches.map((d) => `<tr data-dispatch="${d.id}" style="cursor:pointer">
            <td class="mono nowrap">${esc(d.dispatch_number)}</td>
            <td class="mono ${(d.status === 'dispatched' || d.status === 'delivered') && !d.lr_number ? 'warn' : 'faint'}">${
              esc(d.lr_number || ((d.status === 'dispatched' || d.status === 'delivered') ? 'none yet' : '—'))}</td>
            <td class="dim truncate">${esc(d.transporter || '—')}</td>
            <td class="dim nowrap">${d.dispatched_at ? shortDate(d.dispatched_at) : '—'}</td>
            <td><span class="pill ${DISPATCH_TONE[d.status] || ''}">${DISPATCH_LABEL[d.status] || d.status}</span></td>
          </tr>`).join('')}</tbody></table></div>`
      : emptyState(o.lines.length ? 'Nothing has gone out yet.' : 'Enter the items first — there is nothing to pick.'),
    {
      flush: o.dispatches.length > 0,
      actions: canPick ? '<button class="btn small" id="pick">Start picking</button>' : '',
      note: canPick ? '' : o.status === 'dispatched' ? 'complete' : '',
    });
}

const linesTable = (lines, { editable, showDispatched = false }) => `
  <div class="table-wrap" style="max-height:none"><table class="lines">
    <thead><tr>
      <th style="width:34px">#</th><th>Item</th><th style="width:80px" class="num">Qty</th>
      <th style="width:60px">UoM</th><th style="width:100px" class="num">Rate</th>
      <th style="width:66px" class="num">GST %</th><th style="width:110px" class="num">Amount</th>
      ${showDispatched ? '<th style="width:110px" class="num">Dispatched</th>' : ''}
      ${editable ? '<th style="width:30px"></th>' : ''}
    </tr></thead>
    <tbody id="lines"></tbody>
  </table></div>`;

// ---------------------------------------------------------------------------
// Detail — read-only once shipped, editable while still open
// ---------------------------------------------------------------------------
async function detail(el, id) {
  el.innerHTML = '<div class="loading">Loading order…</div>';
  const o = await api(`/orders/${id}`);
  const editable = o.status === 'open';

  // Lines are held in a model so they can be edited in place. An order pulled
  // in from email arrives with none — its items are inside the PDF, and this
  // is where someone keys them in with the document open beside them.
  const model = {
    customerPoNumber: o.customer_po_number || '',
    poDate: o.po_date || '',
    paymentTermsDays: o.payment_terms_days ?? 0,
    notes: o.notes || '',
    lines: o.lines.map((l) => ({
      itemName: l.item_name, itemCode: l.item_code, itemGuid: l.item_guid,
      brand: l.brand, hsn: l.hsn, qty: l.qty_ordered, units: l.units,
      rate: l.rate, gstRate: l.gst_rate,
      qtyDispatched: l.qty_dispatched,
    })),
  };
  let dirty = false;

  const n = (v) => Number(v) || 0;
  const taxableOf = (l) => n(l.qty) * n(l.rate);
  const totals = () =>
    model.lines.reduce((a, l) => {
      const t = taxableOf(l);
      a.subtotal += t;
      a.tax += (t * n(l.gstRate)) / 100;
      return a;
    }, { subtotal: 0, tax: 0 });

  function draw() {
    const t = totals();
    const needsLines = editable && model.lines.length === 0;

    el.innerHTML = html`
      <div class="toolbar">
        <button class="btn small" id="back">← All orders</button>
        <span class="pill mono">${o.order_number}</span>
        <span class="pill ${raw(STATUS_TONE[o.status] || '')}">${STATUS_LABEL[o.status] || o.status}</span>
        ${raw(o.quotation ? `<span class="pill">from ${esc(o.quotation.quote_number)}</span>` : '')}
        ${raw(o.source !== 'manual' ? `<span class="pill">via ${esc(o.source)}</span>` : '')}
        ${raw(!o.customer_guid && o.status !== 'cancelled'
          ? '<span class="pill bad">Customer not in Tally</span>' : '')}
        <span style="flex:1"></span>
        <span id="savestate" class="faint" style="font-size:12px"></span>
        ${raw(editable ? '<button class="btn primary small" id="save">Save</button>' : '')}
        ${raw(editable ? '<button class="btn small" id="cancel">Cancel order</button>' : '')}
      </div>

      ${raw(o.status === 'cancelled'
        ? `<div class="callout warn" style="margin-bottom:14px"><strong>Cancelled.</strong> ${esc(o.cancelled_reason || 'No reason recorded.')}</div>`
        : '')}

      ${raw(needsLines
        ? `<div class="callout warn" style="margin-bottom:14px">
             <strong>Items not entered yet.</strong> This purchase order came in as a header and a document — its
             items are inside the PDF. ${o.document_url
               ? `<a href="${esc(o.document_url)}" target="_blank" rel="noopener noreferrer">Open the purchase order</a> and key them in below.`
               : 'Add them below.'}
           </div>`
        : '')}

      <div class="quote-grid">
        <div>
          ${raw(card('Ordered',
            `${editable ? `<div class="searchbox" style="margin-bottom:12px">
                <input type="search" id="itemsearch" placeholder="Search 12,000+ SKUs to add a line…" autocomplete="off" />
                <div id="results"></div>
              </div>` : ''}
             ${linesTable(model.lines, { editable, showDispatched: !editable })}`,
            { note: `${model.lines.length} line${model.lines.length === 1 ? '' : 's'}` }))}

          <div style="height:14px"></div>

          ${raw(dispatchCard(o))}

          <div style="height:14px"></div>

          ${raw(invoiceCard(o))}

          <div style="height:14px"></div>

          ${raw(card('History',
            o.events.length
              ? `<div class="totals">${o.events.map((e) => `<div class="row">
                   <span class="dim">${esc(e.note || e.to_stage)}</span>
                   <span class="faint">${esc(e.actor_name || 'system')} · ${dateTime(e.at)}</span>
                 </div>`).join('')}</div>`
              : emptyState('Nothing recorded yet.')
          ))}
        </div>

        <div>
          ${raw(card('Purchase order', editable
            ? `<div class="field">
                 <label for="po">Their PO number</label>
                 <input id="po" value="${esc(model.customerPoNumber)}" placeholder="As printed on their purchase order" />
               </div>
               <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                 <div class="field" style="margin-bottom:0">
                   <label for="podate">PO date</label>
                   <input type="date" id="podate" value="${esc(model.poDate)}" />
                 </div>
                 <div class="field" style="margin-bottom:0">
                   <label for="terms">Payment terms</label>
                   <input id="terms" value="${model.paymentTermsDays}" placeholder="days" />
                 </div>
               </div>
               <div class="credit-panel" style="margin-top:12px">
                 <div class="row"><span class="dim">Customer</span><span>${esc(o.customer_name)}</span></div>
                 <div class="row"><span class="dim">Received</span><span>${shortDate(o.received_at)}</span></div>
               </div>
               ${o.document_url ? `<div style="margin-top:10px"><a href="${esc(o.document_url)}" target="_blank" rel="noopener noreferrer">Open the original purchase order ↗</a></div>` : ''}`
            : `<div class="credit-panel">
                 <div class="row"><span class="dim">Customer</span><span>${esc(o.customer_name)}</span></div>
                 <div class="row"><span class="dim">Their PO</span><span class="mono">${esc(o.customer_po_number || '—')}</span></div>
                 <div class="row"><span class="dim">PO date</span><span>${shortDate(o.po_date)}</span></div>
                 <div class="row"><span class="dim">Received</span><span>${shortDate(o.received_at)}</span></div>
                 <div class="row"><span class="dim">Payment terms</span><span>${o.payment_terms_days} days</span></div>
               </div>
               ${o.document_url ? `<div style="margin-top:10px"><a href="${esc(o.document_url)}" target="_blank" rel="noopener noreferrer">Open the original purchase order ↗</a></div>` : ''}`))}

          <div style="height:14px"></div>
          ${raw(creditCard(o.creditNow, t.subtotal + t.tax, { snapshot: o }))}
          <div style="height:14px"></div>

          ${raw(card('Totals', `<div class="totals">
            <div class="row"><span class="dim">Subtotal</span><span id="t-subtotal">${rupees2(t.subtotal)}</span></div>
            <div class="row"><span class="dim">GST</span><span id="t-gst">${rupees2(t.tax)}</span></div>
            <div class="row grand"><span>Total</span><span id="t-total">${rupees2(t.subtotal + t.tax)}</span></div>
          </div>`))}

          ${raw(editable ? `<div style="height:14px"></div>${card('Notes',
            `<textarea id="notes" placeholder="Anything worth the next person knowing.">${esc(model.notes)}</textarea>`)}` : '')}
        </div>
      </div>
    `;
    drawLines();
    wire();
    markDirty(dirty);
  }

  function drawLines() {
    const body = el.querySelector('#lines');
    if (!model.lines.length) {
      body.innerHTML = `<tr><td colspan="9" class="empty">No items on this order yet.</td></tr>`;
      return;
    }
    body.innerHTML = model.lines
      .map((l, i) => `<tr>
        <td class="faint">${i + 1}</td>
        <td><div class="truncate" title="${esc(l.itemName)}">${esc(l.itemName)}</div>
            <div class="faint mono" style="font-size:11px">${esc(l.itemCode || '')}${esc(l.brand ? ` · ${l.brand}` : '')}</div></td>
        ${editable
          ? `<td><input data-i="${i}" data-k="qty" value="${l.qty}" /></td>
             <td><input class="text" data-i="${i}" data-k="units" value="${esc(l.units || '')}" /></td>
             <td><input data-i="${i}" data-k="rate" value="${l.rate}" /></td>
             <td><input data-i="${i}" data-k="gstRate" value="${l.gstRate || 0}" /></td>`
          : `<td class="num">${qty(l.qty)}</td><td class="dim">${esc(l.units || '')}</td>
             <td class="num">${rupees2(l.rate)}</td><td class="num dim">${l.gstRate}</td>`}
        <td class="num" data-amount="${i}">${rupees2(taxableOf(l))}</td>
        ${editable
          ? `<td><button class="del" data-del="${i}" title="Remove">×</button></td>`
          : `<td class="num ${l.qtyDispatched >= l.qty ? 'ok' : l.qtyDispatched > 0 ? 'warn' : 'faint'}">${qty(l.qtyDispatched)} <span class="faint">/ ${qty(l.qty)}</span></td>`}
      </tr>`)
      .join('');
  }

  function markDirty(state) {
    dirty = state;
    const node = el.querySelector('#savestate');
    if (node) node.textContent = state ? 'Unsaved changes' : '';
  }

  function recalc(i) {
    if (i !== undefined) {
      const cell = el.querySelector(`[data-amount="${i}"]`);
      if (cell) cell.textContent = rupees2(taxableOf(model.lines[i]));
    }
    const t = totals();
    const set = (sel, v) => { const node = el.querySelector(sel); if (node) node.textContent = rupees2(v); };
    set('#t-subtotal', t.subtotal);
    set('#t-gst', t.tax);
    set('#t-total', t.subtotal + t.tax);

    const credit = o.creditNow;
    if (credit) {
      const after = credit.outstanding + t.subtotal + t.tax;
      const over = credit.creditLimit > 0 && after > credit.creditLimit;
      const value = el.querySelector('#c-after');
      if (value) { value.textContent = money(after); value.className = over ? 'bad' : ''; }
      const flag = el.querySelector('#c-after-flag');
      if (flag) {
        flag.innerHTML = over
          ? `<span class="pill bad">Takes them ${money(after - credit.creditLimit)} past their limit</span>`
          : '';
      }
    }
    markDirty(true);
  }

  function wire() {
    el.querySelector('#back').addEventListener('click', () => {
      if (dirty && !confirm('Leave without saving?')) return;
      location.hash = '#/orders';
    });

    // Wired before the early return below: a dispatched order is not editable,
    // and it is exactly the order whose dispatches someone wants to open.
    el.querySelectorAll('tr[data-dispatch]').forEach((row) =>
      row.addEventListener('click', () => { location.hash = `#/dispatch?id=${row.dataset.dispatch}`; })
    );
    el.querySelectorAll('tr[data-invoice]').forEach((row) =>
      row.addEventListener('click', () => { location.hash = `#/invoices?id=${row.dataset.invoice}`; })
    );
    el.querySelector('#pick')?.addEventListener('click', async () => {
      const btn = el.querySelector('#pick');
      if (dirty && !confirm('This order has unsaved changes. Start picking anyway?')) return;
      btn.disabled = true;
      try {
        const d = await api('/dispatches', { method: 'POST', body: JSON.stringify({ orderId: o.id }) });
        location.hash = `#/dispatch?id=${d.id}`;
      } catch (e) { btn.disabled = false; alert(e.message); }
    });

    if (!editable) return;

    el.querySelector('#po')?.addEventListener('input', (e) => { model.customerPoNumber = e.target.value; markDirty(true); });
    el.querySelector('#podate')?.addEventListener('change', (e) => { model.poDate = e.target.value; markDirty(true); });
    el.querySelector('#terms')?.addEventListener('input', (e) => { model.paymentTermsDays = Number(e.target.value) || 0; markDirty(true); });
    el.querySelector('#notes')?.addEventListener('input', (e) => { model.notes = e.target.value; markDirty(true); });

    el.querySelectorAll('.lines input[data-k]').forEach((input) => {
      const apply = () => {
        const i = Number(input.dataset.i);
        const k = input.dataset.k;
        model.lines[i][k] = k === 'units' ? input.value : Number(input.value) || 0;
        recalc(i);
      };
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
    });
    el.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', () => { model.lines.splice(Number(btn.dataset.del), 1); dirty = true; draw(); })
    );

    attachItemSearch(el, o.customer_name, (line) => {
      model.lines.push(line);
      dirty = true;
      draw();
      el.querySelector('#itemsearch')?.focus();
    });

    el.querySelector('#save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api(`/orders/${id}`, {
          method: 'PUT',
          body: JSON.stringify({
            customerPoNumber: model.customerPoNumber || null,
            poDate: model.poDate || null,
            paymentTermsDays: model.paymentTermsDays,
            notes: model.notes || null,
            lines: model.lines,
          }),
        });
        dirty = false;
        render(el);
      } catch (err) {
        alert(err.message);
        e.target.disabled = false;
      }
    });

    el.querySelector('#cancel')?.addEventListener('click', async () => {
      const reason = prompt('Why is this order being cancelled?');
      if (reason === null) return;
      try {
        await api(`/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
        dirty = false;
        render(el);
      } catch (err) {
        alert(err.message);
      }
    });
  }

  draw();
}

/**
 * The catalogue picker, shared by the composer and the detail editor.
 * Calls back with a ready-made order line.
 */
function attachItemSearch(el, customerName, onPick) {
  const input = el.querySelector('#itemsearch');
  const results = el.querySelector('#results');
  if (!input || !results) return;
  let timer;
  let current = [];
  const close = () => { results.innerHTML = ''; };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const term = input.value.trim();
    if (term.length < 2) return close();
    timer = setTimeout(async () => {
      const p = new URLSearchParams({ search: term, limit: '12' });
      if (customerName) p.set('customer', customerName);
      const { rows } = await api(`/catalogue?${p}`);
      current = rows;
      results.innerHTML = rows.length
        ? `<div class="results">${rows.map((r, i) => {
            const stock = r.match_method === 'unmatched'
              ? '<span class="pill">not stocked</span>'
              : `<span class="${r.closing_qty > 0 ? 'dim' : 'bad'}">${qty(r.closing_qty)} ${esc(r.base_units || '')} in stock</span>`;
            const last = r.last_rate ? `<div class="last">last ${rupees2(r.last_rate)} · ${shortDate(r.last_rate_date)}</div>` : '';
            return `<div class="result" data-i="${i}">
              <div><div class="title">${esc(r.name)}</div>
                <div class="meta"><span class="mono">${esc(r.code)}</span><span>${esc(r.brand)}</span>${stock}</div></div>
              <div class="rates"><div class="list">${rupees2(r.list_rate)}</div>${last}</div>
            </div>`;
          }).join('')}</div>`
        : `<div class="results"><div class="empty">Nothing matches “${esc(term)}”.</div></div>`;

      results.querySelectorAll('.result').forEach((node) =>
        node.addEventListener('click', () => {
          const r = current[Number(node.dataset.i)];
          input.value = '';
          close();
          onPick({
            itemName: r.name, itemCode: r.code, itemGuid: r.tally_guid, brand: r.brand, hsn: r.hsn,
            qty: 1, units: r.units || 'Nos', rate: r.last_rate ?? r.list_rate, gstRate: r.gst_rate ?? 18,
          });
        })
      );
    }, 180);
  });
  document.addEventListener('click', (e) => {
    if (!results.contains(e.target) && e.target !== input) close();
  });
}

// ---------------------------------------------------------------------------
// Composer (recording a new order)
// ---------------------------------------------------------------------------
async function composer(el, _id, quotationId) {
  el.innerHTML = '<div class="loading">Loading…</div>';
  const [{ customers }, { orderNumber, draft }] = await Promise.all([
    api('/customers'),
    api(`/orders/new${quotationId ? `?quotation=${quotationId}` : ''}`),
  ]);

  const model = {
    orderNumber,
    quotationId: draft?.quotationId ?? null,
    quoteNumber: draft?.quoteNumber ?? null,
    customerName: draft?.customerName ?? '',
    customerGuid: draft?.customerGuid ?? null,
    customerPoNumber: '',
    poDate: todayISO(),
    receivedAt: todayISO(),
    paymentTermsDays: null,
    notes: '',
    lines: draft?.lines ?? [],
  };

  let credit = null;
  const loadCredit = async () => {
    credit = model.customerName
      ? await api(`/customers/${encodeURIComponent(model.customerName)}/credit`).catch(() => null)
      : null;
    if (credit && model.paymentTermsDays === null) model.paymentTermsDays = credit.creditPeriodDays;
  };
  await loadCredit();

  const n = (v) => Number(v) || 0;
  const taxableOf = (l) => n(l.qty) * n(l.rate);
  const totals = () =>
    model.lines.reduce(
      (a, l) => {
        const t = taxableOf(l);
        a.subtotal += t;
        a.tax += (t * n(l.gstRate)) / 100;
        return a;
      },
      { subtotal: 0, tax: 0 }
    );

  function draw() {
    const t = totals();
    el.innerHTML = html`
      <div class="toolbar">
        <button class="btn small" id="back">← All orders</button>
        <span class="pill mono">${model.orderNumber}</span>
        ${raw(model.quoteNumber ? `<span class="pill accent">from ${esc(model.quoteNumber)}</span>` : '')}
        <span style="flex:1"></span>
        <button class="btn primary small" id="save">Record order</button>
      </div>

      ${raw(model.quoteNumber
        ? `<div class="callout" style="margin-bottom:14px">
             Prefilled from ${esc(model.quoteNumber)} at the rates that were quoted. Change anything the customer's
             purchase order actually says — the PO is what gets recorded, not the quote. Saving marks the quotation
             accepted.
           </div>`
        : '')}

      <div class="quote-grid">
        <div>
          ${raw(card('Ordered', `${
            model.lines.length ? '' :
            '<div class="callout warn" style="margin-bottom:12px">Nothing to order yet. Convert an accepted quotation, or add lines below.</div>'
          }<div class="searchbox" style="margin-bottom:12px">
              <input type="search" id="itemsearch" placeholder="Search 12,000+ SKUs to add a line…" autocomplete="off" />
              <div id="results"></div>
            </div>
            ${linesTable(model.lines, { editable: true })}`,
            { note: `${model.lines.length} line${model.lines.length === 1 ? '' : 's'}` }))}

          <div style="height:14px"></div>
          ${raw(card('Notes', `<textarea id="notes" placeholder="Anything about this order worth the next person knowing.">${esc(model.notes)}</textarea>`))}
        </div>

        <div>
          ${raw(card('Purchase order', `
            <div class="field">
              <label for="customer">Customer</label>
              <input list="customerlist" id="customer" value="${esc(model.customerName)}"
                     placeholder="Start typing a customer name" ${model.quotationId ? 'disabled' : ''} />
              <datalist id="customerlist">
                ${customers.map((c) => `<option value="${esc(c.name)}"></option>`).join('')}
              </datalist>
            </div>
            <div class="field">
              <label for="po">Their PO number</label>
              <input id="po" value="${esc(model.customerPoNumber)}" placeholder="As printed on their purchase order" />
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div class="field" style="margin-bottom:0">
                <label for="podate">PO date</label>
                <input type="date" id="podate" value="${esc(model.poDate)}" />
              </div>
              <div class="field" style="margin-bottom:0">
                <label for="terms">Payment terms</label>
                <input id="terms" value="${model.paymentTermsDays ?? ''}" placeholder="days" />
              </div>
            </div>`))}

          <div style="height:14px"></div>
          <div id="creditcard">${raw(creditCard(credit, t.subtotal + t.tax))}</div>
          <div style="height:14px"></div>

          ${raw(card('Totals', `<div class="totals">
            <div class="row"><span class="dim">Subtotal</span><span id="t-subtotal">${rupees2(t.subtotal)}</span></div>
            <div class="row"><span class="dim">GST</span><span id="t-gst">${rupees2(t.tax)}</span></div>
            <div class="row grand"><span>Total</span><span id="t-total">${rupees2(t.subtotal + t.tax)}</span></div>
          </div>`))}
        </div>
      </div>
    `;
    drawLines();
    wire();
  }

  function drawLines() {
    const body = el.querySelector('#lines');
    if (!model.lines.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">No lines yet.</td></tr>';
      return;
    }
    body.innerHTML = model.lines
      .map((l, i) => `<tr>
        <td class="faint">${i + 1}</td>
        <td><div class="truncate" title="${esc(l.itemName)}">${esc(l.itemName)}</div>
            <div class="faint mono" style="font-size:11px">${esc(l.itemCode || '')}${esc(l.brand ? ` · ${l.brand}` : '')}</div></td>
        <td><input data-i="${i}" data-k="qty" value="${l.qty}" /></td>
        <td><input class="text" data-i="${i}" data-k="units" value="${esc(l.units || '')}" /></td>
        <td><input data-i="${i}" data-k="rate" value="${l.rate}" /></td>
        <td><input data-i="${i}" data-k="gstRate" value="${l.gstRate || 0}" /></td>
        <td class="num" data-amount="${i}">${rupees2(taxableOf(l))}</td>
        <td><button class="del" data-del="${i}" title="Remove">×</button></td>
      </tr>`)
      .join('');
  }

  function recalc(i) {
    if (i !== undefined) {
      const cell = el.querySelector(`[data-amount="${i}"]`);
      if (cell) cell.textContent = rupees2(taxableOf(model.lines[i]));
    }
    const t = totals();
    const set = (id, v) => { const node = el.querySelector(id); if (node) node.textContent = rupees2(v); };
    set('#t-subtotal', t.subtotal);
    set('#t-gst', t.tax);
    set('#t-total', t.subtotal + t.tax);

    if (credit) {
      const after = credit.outstanding + t.subtotal + t.tax;
      const over = credit.creditLimit > 0 && after > credit.creditLimit;
      const value = el.querySelector('#c-after');
      if (value) { value.textContent = money(after); value.className = over ? 'bad' : ''; }
      const flag = el.querySelector('#c-after-flag');
      if (flag) {
        flag.innerHTML = over
          ? `<span class="pill bad">Takes them ${money(after - credit.creditLimit)} past their limit</span>`
          : '';
      }
    }
  }

  function wire() {
    el.querySelector('#back').addEventListener('click', () => { location.hash = '#/orders'; });
    el.querySelector('#po').addEventListener('input', (e) => { model.customerPoNumber = e.target.value; });
    el.querySelector('#podate').addEventListener('change', (e) => { model.poDate = e.target.value; });
    el.querySelector('#terms').addEventListener('input', (e) => { model.paymentTermsDays = Number(e.target.value) || 0; });
    el.querySelector('#notes').addEventListener('input', (e) => { model.notes = e.target.value; });

    el.querySelector('#customer')?.addEventListener('change', async (e) => {
      model.customerName = e.target.value.trim();
      await loadCredit();
      el.querySelector('#creditcard').innerHTML = creditCard(credit, totals().subtotal + totals().tax);
      const terms = el.querySelector('#terms');
      if (terms && credit) terms.value = model.paymentTermsDays ?? credit.creditPeriodDays;
      recalc();
    });

    el.querySelectorAll('.lines input[data-k]').forEach((input) => {
      const apply = () => {
        const i = Number(input.dataset.i);
        const k = input.dataset.k;
        model.lines[i][k] = k === 'units' ? input.value : Number(input.value) || 0;
        recalc(i);
      };
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
    });
    el.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', () => { model.lines.splice(Number(btn.dataset.del), 1); draw(); })
    );

    wireSearch();
    el.querySelector('#save').addEventListener('click', save);
  }

  function wireSearch() {
    attachItemSearch(el, model.customerName, (line) => {
      model.lines.push(line);
      draw();
      el.querySelector('#itemsearch')?.focus();
    });
  }

  async function save(e) {
    if (!model.customerName) return alert('Pick a customer first.');
    if (!model.lines.length) return alert('An order needs at least one line.');
    e.target.disabled = true;
    try {
      const saved = await api('/orders', {
        method: 'POST',
        body: JSON.stringify({
          customerName: model.customerName,
          customerGuid: model.customerGuid,
          customerPoNumber: model.customerPoNumber || null,
          poDate: model.poDate || null,
          receivedAt: model.receivedAt,
          quotationId: model.quotationId,
          paymentTermsDays: model.paymentTermsDays,
          notes: model.notes || null,
          lines: model.lines,
        }),
      });
      location.hash = `#/orders?id=${saved.id}`;
    } catch (err) {
      alert(err.message);
      e.target.disabled = false;
    }
  }

  draw();
}
