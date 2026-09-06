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
      ${raw(kpi({ label: 'Part dispatched', value: count(summary.byStatus.part_dispatched?.n || 0), sub: 'shipped in part' }))}
      ${raw(kpi({ label: 'Dispatched', value: count(summary.byStatus.dispatched?.n || 0), sub: 'fully shipped' }))}
    </div>

    <div class="toolbar">
      <button class="btn primary" id="new">Record an order</button>
      <input type="search" id="q" placeholder="Order no, customer, or their PO number…" />
      <select id="status">
        <option value="">Any status</option>
        <option value="open">Awaiting dispatch</option>
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
                <td class="num dim">${o.line_count}</td>
                <td class="num">${money(o.total)}</td>
                <td><span class="pill ${CREDIT_TONE[o.credit_status] || ''}">${CREDIT_LABEL[o.credit_status] || o.credit_status}</span></td>
                <td><span class="pill ${STATUS_TONE[o.status] || ''}">${STATUS_LABEL[o.status] || o.status}</span></td>
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
// Detail (a recorded order)
// ---------------------------------------------------------------------------
async function detail(el, id) {
  el.innerHTML = '<div class="loading">Loading order…</div>';
  const o = await api(`/orders/${id}`);
  const editable = o.status === 'open';

  el.innerHTML = html`
    <div class="toolbar">
      <button class="btn small" id="back">← All orders</button>
      <span class="pill mono">${o.order_number}</span>
      <span class="pill ${raw(STATUS_TONE[o.status] || '')}">${STATUS_LABEL[o.status] || o.status}</span>
      ${raw(o.quotation ? `<span class="pill">from ${esc(o.quotation.quote_number)}</span>` : '')}
      <span style="flex:1"></span>
      ${raw(editable ? '<button class="btn small" id="cancel">Cancel order</button>' : '')}
    </div>

    ${raw(o.status === 'cancelled'
      ? `<div class="callout warn" style="margin-bottom:14px"><strong>Cancelled.</strong> ${esc(o.cancelled_reason || 'No reason recorded.')}</div>`
      : '')}

    <div class="quote-grid">
      <div>
        ${raw(card('Ordered', linesTable(o.lines, { editable: false, showDispatched: true }), {
          note: `${o.lines.length} line${o.lines.length === 1 ? '' : 's'}`,
        }))}

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
        ${raw(card('Order', `
          <div class="credit-panel">
            <div class="row"><span class="dim">Customer</span><span>${esc(o.customer_name)}</span></div>
            <div class="row"><span class="dim">Their PO</span><span class="mono">${esc(o.customer_po_number || '—')}</span></div>
            <div class="row"><span class="dim">PO date</span><span>${shortDate(o.po_date)}</span></div>
            <div class="row"><span class="dim">Received</span><span>${shortDate(o.received_at)}</span></div>
            <div class="row"><span class="dim">Payment terms</span><span>${o.payment_terms_days} days</span></div>
          </div>`))}

        <div style="height:14px"></div>
        ${raw(creditCard(o.creditNow, o.total, { snapshot: o }))}
        <div style="height:14px"></div>

        ${raw(card('Totals', `<div class="totals">
          <div class="row"><span class="dim">Subtotal</span><span>${rupees2(o.subtotal)}</span></div>
          <div class="row"><span class="dim">GST</span><span>${rupees2(o.tax_amount)}</span></div>
          <div class="row grand"><span>Total</span><span>${rupees2(o.total)}</span></div>
        </div>`))}
      </div>
    </div>
  `;

  el.querySelector('#lines').innerHTML = o.lines
    .map((l, i) => `<tr>
      <td class="faint">${i + 1}</td>
      <td><div class="truncate" title="${esc(l.item_name)}">${esc(l.item_name)}</div>
          <div class="faint mono" style="font-size:11px">${esc(l.item_code || '')}${esc(l.brand ? ` · ${l.brand}` : '')}</div></td>
      <td class="num">${qty(l.qty_ordered)}</td>
      <td class="dim">${esc(l.units || '')}</td>
      <td class="num">${rupees2(l.rate)}</td>
      <td class="num dim">${l.gst_rate}</td>
      <td class="num">${rupees2(l.amount)}</td>
      <td class="num ${l.qty_dispatched >= l.qty_ordered ? 'ok' : l.qty_dispatched > 0 ? 'warn' : 'faint'}">
        ${qty(l.qty_dispatched)}${l.qty_pending > 0 ? ` <span class="faint">/ ${qty(l.qty_ordered)}</span>` : ''}
      </td>
    </tr>`)
    .join('');

  el.querySelector('#back').addEventListener('click', () => { location.hash = '#/orders'; });
  el.querySelector('#cancel')?.addEventListener('click', async () => {
    const reason = prompt('Why is this order being cancelled?');
    if (reason === null) return;
    try {
      await api(`/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
      render(el);
    } catch (err) {
      alert(err.message);
    }
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
    const input = el.querySelector('#itemsearch');
    const results = el.querySelector('#results');
    let timer;
    let current = [];
    const close = () => { results.innerHTML = ''; };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const term = input.value.trim();
      if (term.length < 2) return close();
      timer = setTimeout(async () => {
        const p = new URLSearchParams({ search: term, limit: '12' });
        if (model.customerName) p.set('customer', model.customerName);
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
            model.lines.push({
              itemName: r.name, itemCode: r.code, itemGuid: r.tally_guid, brand: r.brand, hsn: r.hsn,
              qty: 1, units: r.units || 'Nos', rate: r.last_rate ?? r.list_rate, gstRate: r.gst_rate ?? 18,
            });
            input.value = '';
            close();
            draw();
            el.querySelector('#itemsearch')?.focus();
          })
        );
      }, 180);
    });
    document.addEventListener('click', (e) => {
      if (!results.contains(e.target) && e.target !== input) close();
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
