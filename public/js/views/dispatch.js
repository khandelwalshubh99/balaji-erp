import { api, html, raw, card, kpi, money, rupees2, count, qty, shortDate, dateTime, esc, emptyState } from '../util.js';

export const title = 'Dispatch';

const TONE = { picking: 'accent', packed: 'warn', dispatched: '', delivered: 'ok' };
const LABEL = {
  picking: 'Picking',
  packed: 'Packed, still here',
  dispatched: 'In transit',
  delivered: 'Delivered',
};
/** What each button does next, in the words of the person doing it. */
const NEXT = {
  picking: { status: 'packed', label: 'Mark packed' },
  packed: { status: 'dispatched', label: 'It has left' },
  dispatched: { status: 'delivered', label: 'Mark delivered' },
};

export async function render(el) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const id = params.get('id');
  if (id) return detail(el, Number(id));
  return list(el);
}

// ---------------------------------------------------------------------------
// List — three questions on one screen
// ---------------------------------------------------------------------------
async function list(el) {
  const { dispatches, readyToPick, summary } = await api('/dispatches');

  el.innerHTML = html`
    <div class="grid cols-4" style="margin-bottom:14px">
      ${raw(kpi({
        label: 'Ready to pick',
        value: count(summary.readyToPick),
        sub: 'orders with something still to send',
      }))}
      ${raw(kpi({
        label: 'On the floor',
        value: count(summary.picking + summary.packed),
        sub: `${count(summary.picking)} being picked · ${count(summary.packed)} packed`,
      }))}
      ${raw(kpi({
        label: 'In transit',
        value: count(summary.inTransit),
        sub: `${count(summary.shippedThisMonth)} sent this month`,
      }))}
      ${raw(kpi({
        // Two queues, one tile: both mean a consignment has moved and the
        // paper has not caught up, and both are meant to sit at zero. Split
        // across two tiles they read as ordinary counters; together they read
        // as the backlog they are.
        label: 'Paperwork outstanding',
        value: count(summary.awaitingLr + summary.awaitingPod),
        tone: summary.awaitingLr + summary.awaitingPod ? 'warn' : '',
        sub: `${count(summary.awaitingLr)} without an LR · ${count(summary.awaitingPod)} without a POD`,
      }))}
    </div>

    <div id="pickq"></div>
    <div style="height:14px"></div>

    <div class="toolbar">
      <input type="search" id="q" placeholder="DN number, LR, transporter, order or customer…" />
      <select id="status">
        <option value="">Everything</option>
        <option value="open">Still here (picking or packed)</option>
        <option value="picking">Picking</option>
        <option value="packed">Packed</option>
        <option value="dispatched">In transit</option>
        <option value="awaiting_lr">Gone without an LR</option>
        <option value="delivered">Delivered</option>
        <option value="awaiting_pod">Awaiting POD</option>
      </select>
    </div>
    <div id="holder"></div>
  `;

  drawPickQueue(el, readyToPick);
  drawDispatches(el, dispatches);

  let timer;
  const refresh = async () => {
    const r = await api(`/dispatches?${new URLSearchParams({
      search: el.querySelector('#q').value,
      status: el.querySelector('#status').value,
    })}`);
    drawDispatches(el, r.dispatches);
  };
  el.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 180); });
  el.querySelector('#status').addEventListener('change', refresh);
}

/**
 * What is waiting to go out.
 *
 * Ordered oldest first rather than newest, because this is a work queue and
 * the oldest outstanding order is the one someone is already chasing.
 */
function drawPickQueue(el, rows) {
  el.querySelector('#pickq').innerHTML = card(
    'Ready to pick',
    rows.length
      ? `<div class="table-wrap" style="max-height:320px"><table>
          <thead><tr>
            <th>Order</th><th>Their PO</th><th>Customer</th><th>Received</th>
            <th class="num">Lines left</th><th class="num">Value</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>${rows.map((o) => `<tr>
            <td class="mono nowrap">${esc(o.order_number)}</td>
            <td class="mono faint nowrap">${esc(o.customer_po_number || '—')}</td>
            <td class="truncate">${esc(o.customer_name)}</td>
            <td class="dim nowrap">${shortDate(o.received_at)}</td>
            <td class="num">${o.lines_pending} of ${o.lines}</td>
            <td class="num">${money(o.total)}</td>
            <td>${o.status === 'part_dispatched' ? '<span class="pill warn">Part dispatched</span>' : '<span class="pill accent">Awaiting dispatch</span>'}</td>
            <td><button class="btn small" data-pick="${o.id}">Start picking</button></td>
          </tr>`).join('')}</tbody></table></div>`
      : emptyState('Nothing outstanding. Every order with items on it has been dispatched in full.'),
    { flush: true, note: rows.length ? 'oldest first' : '' }
  );

  el.querySelectorAll('button[data-pick]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Raising…';
      try {
        const d = await api('/dispatches', { method: 'POST', body: JSON.stringify({ orderId: Number(btn.dataset.pick) }) });
        location.hash = `#/dispatch?id=${d.id}`;
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Start picking';
        alert(e.message);
      }
    })
  );
}

function drawDispatches(el, rows) {
  el.querySelector('#holder').innerHTML = card(
    'Dispatches',
    rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr>
            <th>DN</th><th>Order</th><th>Customer</th><th class="num">Lines</th><th class="num">Units</th>
            <th>LR</th><th>Transporter</th><th>Left</th><th>Status</th>
          </tr></thead>
          <tbody>${rows.map((d) => {
            const gone = d.status === 'dispatched' || d.status === 'delivered';
            return `<tr data-id="${d.id}" style="cursor:pointer">
              <td class="mono nowrap">${esc(d.dispatch_number)}</td>
              <td class="mono faint nowrap">${esc(d.order_number)}</td>
              <td class="truncate">${esc(d.customer_name)}</td>
              <td class="num dim">${d.line_count}</td>
              <td class="num">${qty(d.units)}</td>
              <td class="mono ${gone && !d.lr_number ? 'warn' : 'faint'} nowrap">${
                d.lr_number ? esc(d.lr_number) : gone ? 'none yet' : '—'
              }</td>
              <td class="dim truncate">${esc(d.transporter || '—')}</td>
              <td class="dim nowrap">${d.dispatched_at ? shortDate(d.dispatched_at) : '—'}</td>
              <td><span class="pill ${TONE[d.status] || ''}">${LABEL[d.status] || d.status}</span>${
                d.status === 'delivered' && !d.pod_received ? ' <span class="pill warn">no POD</span>' : ''
              }</td>
            </tr>`;
          }).join('')}</tbody></table></div>`
      : emptyState('No dispatches yet. Start one from the queue above.'),
    { flush: true }
  );
  el.querySelectorAll('tr[data-id]').forEach((row) =>
    row.addEventListener('click', () => { location.hash = `#/dispatch?id=${row.dataset.id}`; })
  );
}

// ---------------------------------------------------------------------------
// Detail — the pick list, then the lorry
// ---------------------------------------------------------------------------
async function detail(el, id) {
  el.innerHTML = '<div class="loading">Loading dispatch…</div>';
  const d = await api(`/dispatches/${id}`);

  // Editable means "still in the building". Once it has gone, the quantities
  // are a record of what went, and the only thing that can still change is the
  // paperwork chasing it.
  const editable = d.status === 'picking' || d.status === 'packed';

  /**
   * Every outstanding line of the order, not only the ones on this dispatch.
   *
   * A pick list that hides what it is not taking cannot be used to decide
   * whether to take it — and deciding is most of the job when the rack is
   * short. `available` already excludes this dispatch's own claim, so it is
   * the true ceiling for this line.
   */
  const model = {
    lrNumber: d.lr_number || '',
    transporter: d.transporter || '',
    lrDate: d.lr_date || '',
    freightAmount: d.freight_amount || 0,
    notes: d.notes || '',
    lines: (editable ? d.orderLines : d.lines).map((row) => {
      const on = editable ? d.lines.find((l) => l.order_line_id === row.id) : row;
      const ol = editable ? row : { id: row.order_line_id, qty_ordered: row.qty_ordered, qty_gone: null, qty_allocated: null, qty_pending: null };
      return {
        orderLineId: ol.id,
        lineNo: editable ? row.line_no : row.line_no,
        itemName: editable ? row.item_name : row.item_name,
        itemCode: row.item_code || '',
        units: row.units || row.order_units || 'Nos',
        rate: row.rate || 0,
        ordered: ol.qty_ordered,
        gone: editable ? row.qty_gone : null,
        allocated: editable ? row.qty_allocated : null,
        available: editable ? row.qty_pending : null,
        qty: on ? on.qty_dispatched : 0,
        substitutedWith: on?.substituted_with || '',
        notes: on?.notes || '',
      };
    }),
  };

  let dirty = false;
  const n = (v) => Number(v) || 0;
  const picked = () => model.lines.reduce((a, l) => a + n(l.qty), 0);
  const value = () => model.lines.reduce((a, l) => a + n(l.qty) * n(l.rate), 0);
  const short = () => model.lines.filter((l) => l.available !== null && n(l.qty) < l.available);

  function draw() {
    const next = NEXT[d.status];

    el.innerHTML = html`
      <div class="toolbar">
        <button class="btn small" id="back">← All dispatches</button>
        <span class="pill mono">${d.dispatch_number}</span>
        <span class="pill ${raw(TONE[d.status] || '')}">${LABEL[d.status] || d.status}</span>
        ${raw(d.order ? `<a class="pill mono" href="#/orders?id=${d.order.id}" title="Open the order">${esc(d.order.order_number)}</a>` : '')}
        ${raw(d.awaitingLr ? '<span class="pill warn">No LR yet</span>' : '')}
        ${raw(d.invoice
          ? `<a class="pill mono" href="#/invoices?id=${d.invoice.id}" title="${esc(d.invoice.position.label)}">${esc(d.invoice.invoice_number)}</a>`
          : ['dispatched', 'delivered'].includes(d.status) ? '<span class="pill warn">Not invoiced</span>' : '')}
        ${raw(d.status === 'delivered' && !d.pod_received ? '<span class="pill warn">POD not back</span>' : '')}
        <span style="flex:1"></span>
        <span id="savestate" class="faint" style="font-size:12px"></span>
        <button class="btn primary small" id="save">Save</button>
        ${raw(next ? `<button class="btn small" id="advance">${esc(next.label)}</button>` : '')}
        ${raw(d.status === 'packed' ? '<button class="btn small" id="unpack">Back to picking</button>' : '')}
        ${raw(d.status === 'picking' ? '<button class="btn small" id="discard">Discard</button>' : '')}
        ${raw(d.status === 'delivered'
          ? `<button class="btn small" id="pod">${d.pod_received ? 'POD not received' : 'POD received'}</button>`
          : '')}
      </div>

      ${raw(!d.invoice && ['dispatched', 'delivered'].includes(d.status)
        ? `<div class="callout warn" style="margin-bottom:14px">
             <strong>This consignment has not been invoiced.</strong>
             Nothing is chasing payment for it — the clock lives on the Tally bill, and there is no bill until
             an invoice is raised and recorded. It is worth ${esc(rupees2(d.invoiceValue?.total || 0))} at the
             order rates. <a href="#/invoices">Record the invoice</a>.
           </div>`
        : '')}

      ${raw(d.awaitingLr
        ? `<div class="callout warn" style="margin-bottom:14px">
             <strong>This has gone out with no lorry receipt recorded.</strong>
             That is normal for a few hours — the transporter hands it over later. Add it below when it arrives;
             until then this sits in the <em>Awaiting LR</em> queue so it cannot be forgotten.
           </div>`
        : '')}

      <div id="shortnote">${raw(shortNote())}</div>

      <div class="quote-grid">
        <div>
          ${raw(card(editable ? 'Pick list' : 'What went',
            linesTable(editable),
            { note: `${count(picked())} unit${picked() === 1 ? '' : 's'} across ${count(model.lines.filter((l) => n(l.qty) > 0).length)} line(s)` }))}

          <div style="height:14px"></div>

          ${raw(card('History',
            d.events.length
              ? `<div class="totals">${d.events.map((e) => `<div class="row">
                   <span class="dim">${esc(e.note || `${e.from_stage || '—'} → ${e.to_stage}`)}</span>
                   <span class="faint">${esc(e.actor_name || 'system')} · ${dateTime(e.at)}</span>
                 </div>`).join('')}</div>`
              : emptyState('Nothing recorded yet.')
          ))}
        </div>

        <div>
          ${raw(card('Consignment', `<div class="credit-panel">
            <div class="row"><span class="dim">Customer</span><span>${esc(d.order?.customer_name || '—')}</span></div>
            <div class="row"><span class="dim">Order</span><span class="mono">${esc(d.order?.order_number || '—')}</span></div>
            <div class="row"><span class="dim">Their PO</span><span class="mono">${esc(d.order?.customer_po_number || '—')}</span></div>
            <div class="row"><span class="dim">Packed</span><span>${d.packed_at ? shortDate(d.packed_at) : '—'}</span></div>
            <div class="row"><span class="dim">Left</span><span>${d.dispatched_at ? shortDate(d.dispatched_at) : '—'}</span></div>
            <div class="row"><span class="dim">Delivered</span><span>${d.delivered_at ? shortDate(d.delivered_at) : '—'}</span></div>
            <div class="row"><span class="dim">POD</span><span>${d.pod_received ? 'received' : d.status === 'delivered' ? 'not back' : '—'}</span></div>
          </div>
          ${d.order?.document_url
            ? `<div style="margin-top:10px"><a href="${esc(d.order.document_url)}" target="_blank" rel="noopener noreferrer">Open the purchase order ↗</a></div>`
            : ''}`))}

          <div style="height:14px"></div>

          ${raw(card('Lorry receipt', `
            <div class="field">
              <label for="transporter">Transporter</label>
              <input id="transporter" value="${esc(model.transporter)}" placeholder="Who is carrying it" />
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div class="field" style="margin-bottom:0">
                <label for="lr">LR number</label>
                <input id="lr" value="${esc(model.lrNumber)}" placeholder="As on the receipt" />
              </div>
              <div class="field" style="margin-bottom:0">
                <label for="lrdate">LR date</label>
                <input type="date" id="lrdate" value="${esc(model.lrDate)}" />
              </div>
            </div>
            <div class="field" style="margin-top:12px;margin-bottom:0">
              <label for="freight">Freight</label>
              <input id="freight" value="${model.freightAmount || ''}" placeholder="₹, if we are paying it" />
            </div>
            <p class="faint" style="font-size:11.5px;margin:10px 0 0">
              Editable after dispatch on purpose — the receipt usually turns up after the vehicle has gone.
            </p>`,
            { note: d.lr_number ? '' : 'not recorded' }))}

          <div style="height:14px"></div>

          ${raw(card('This consignment', `<div class="totals">
            <div class="row"><span class="dim">Lines</span><span id="t-lines">${count(model.lines.filter((l) => n(l.qty) > 0).length)}</span></div>
            <div class="row"><span class="dim">Units</span><span id="t-units">${qty(picked())}</span></div>
            <div class="row grand"><span>Value</span><span id="t-value">${rupees2(value())}</span></div>
          </div>
          <p class="faint" style="font-size:11.5px;margin:10px 0 0">
            At the rates on the order. The invoice is raised separately, against what actually went.
          </p>`))}

          <div style="height:14px"></div>
          ${raw(card('Notes', `<textarea id="notes" placeholder="Anything the next person needs — a damaged carton, a gate pass number.">${esc(model.notes)}</textarea>`))}
        </div>
      </div>
    `;
    wire();
  }

  /**
   * One row per outstanding order line, not one per line being sent.
   *
   * `Ordered / Gone / Left` in front of the box someone types into is what
   * makes a short pick a decision rather than an accident: the number they are
   * about to enter is next to the number it is short of.
   */
  function linesTable(editable) {
    if (!model.lines.length) return emptyState('Nothing on this dispatch.');
    return `<div class="table-wrap" style="max-height:none"><table class="lines">
      <thead><tr>
        <th style="width:34px">#</th><th>Item</th>
        ${editable ? '<th style="width:70px" class="num">Ordered</th><th style="width:64px" class="num">Gone</th><th style="width:64px" class="num">Left</th>' : '<th style="width:70px" class="num">Ordered</th>'}
        <th style="width:84px" class="num">${editable ? 'Sending' : 'Sent'}</th>
        <th style="width:56px">UoM</th>
        <th style="width:150px">Substituted with</th>
        <th style="width:150px">Note</th>
      </tr></thead>
      <tbody>${model.lines.map((l, i) => `<tr>
        <td class="faint">${l.lineNo}</td>
        <td>${esc(l.itemName)}${l.itemCode ? `<div class="faint mono" style="font-size:11px">${esc(l.itemCode)}</div>` : ''}</td>
        <td class="num dim">${qty(l.ordered)}</td>
        ${editable ? `<td class="num faint">${l.gone ? qty(l.gone) : '—'}</td>
          <td class="num ${l.allocated ? 'warn' : 'dim'}" ${l.allocated ? `title="${qty(l.allocated)} is on another open pick list"` : ''}>${qty(l.available)}</td>` : ''}
        <td class="num">${editable
          ? `<input class="num" data-i="${i}" data-f="qty" value="${l.qty}" inputmode="decimal" />`
          : qty(l.qty)}</td>
        <td class="dim">${esc(l.units)}</td>
        <td>${editable
          ? `<input class="text" data-i="${i}" data-f="substitutedWith" value="${esc(l.substitutedWith)}" placeholder="if something else went" />`
          : `<span class="${l.substitutedWith ? 'warn' : 'faint'}">${esc(l.substitutedWith || '—')}</span>`}</td>
        <td>${editable
          ? `<input class="text" data-i="${i}" data-f="notes" value="${esc(l.notes)}" placeholder="—" />`
          : `<span class="faint">${esc(l.notes || '—')}</span>`}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  /**
   * Which lines are going out short, in the words of the person packing.
   *
   * Redrawn on every keystroke rather than on load, because the moment this
   * matters is the moment somebody types 150 into a box that said 200. Telling
   * them afterwards, on the next screen, is telling them too late — and the
   * whole reason this stage exists is that a short shipment noticed on the
   * loading bay costs nothing and one noticed by the customer costs the order.
   */
  function shortNote() {
    if (!editable) return '';
    const lines = short();
    if (!lines.length) return '';
    return `<div class="callout" style="margin-bottom:14px">
      <strong>${lines.length} line${lines.length === 1 ? ' is' : 's are'} going short.</strong>
      ${esc(lines.map((l) => `${l.itemName}: ${qty(l.qty)} of ${qty(l.available)}`).join(' · '))}.
      That is fine — send what you have. The balance stays outstanding on
      ${esc(d.order?.order_number || 'the order')} and comes straight back to the pick queue.
    </div>`;
  }

  function recalc() {
    el.querySelector('#t-units').textContent = qty(picked());
    el.querySelector('#t-value').textContent = rupees2(value());
    el.querySelector('#t-lines').textContent = count(model.lines.filter((l) => n(l.qty) > 0).length);
    el.querySelector('#shortnote').innerHTML = shortNote();
  }

  const mark = (text) => { el.querySelector('#savestate').textContent = text; };

  function collect() {
    model.transporter = el.querySelector('#transporter').value;
    model.lrNumber = el.querySelector('#lr').value;
    model.lrDate = el.querySelector('#lrdate').value;
    model.freightAmount = el.querySelector('#freight').value;
    model.notes = el.querySelector('#notes').value;
  }

  async function save({ quiet = false } = {}) {
    collect();
    const body = {
      transporter: model.transporter, lrNumber: model.lrNumber, lrDate: model.lrDate,
      freightAmount: model.freightAmount, notes: model.notes,
    };
    // Quantities are only ever sent while the lot is still here. Sending them
    // for a dispatch that has gone would be refused by the server anyway; not
    // sending them means the LR fields stay editable, which is the point.
    if (editable) {
      body.lines = model.lines
        .filter((l) => n(l.qty) > 0)
        .map((l) => ({ orderLineId: l.orderLineId, qty: n(l.qty), units: l.units, substitutedWith: l.substitutedWith, notes: l.notes }));
    }
    const updated = await api(`/dispatches/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    dirty = false;
    if (!quiet) mark('Saved');
    return updated;
  }

  function wire() {
    el.querySelector('#back').addEventListener('click', () => { location.hash = '#/dispatch'; });

    el.querySelectorAll('input[data-i]').forEach((input) =>
      input.addEventListener('input', () => {
        const line = model.lines[Number(input.dataset.i)];
        line[input.dataset.f] = input.dataset.f === 'qty' ? input.value : input.value;
        dirty = true;
        mark('Unsaved');
        if (input.dataset.f === 'qty') recalc();
      })
    );
    ['#transporter', '#lr', '#lrdate', '#freight', '#notes'].forEach((sel) =>
      el.querySelector(sel).addEventListener('input', () => { dirty = true; mark('Unsaved'); })
    );

    el.querySelector('#save').addEventListener('click', async () => {
      const btn = el.querySelector('#save');
      btn.disabled = true;
      try { await save(); Object.assign(d, await api(`/dispatches/${id}`)); }
      catch (e) { mark(''); alert(e.message); }
      btn.disabled = false;
    });

    const advance = el.querySelector('#advance');
    if (advance) advance.addEventListener('click', async () => {
      advance.disabled = true;
      try {
        // Saved first, always. Someone typing a short quantity and pressing
        // "It has left" means both, and losing the quantity because they did
        // not press Save is exactly the data loss this stage exists to stop.
        if (dirty || editable) await save({ quiet: true });
        await api(`/dispatches/${id}/status`, { method: 'POST', body: JSON.stringify({ status: NEXT[d.status].status }) });
        await detail(el, id);
      } catch (e) { advance.disabled = false; alert(e.message); }
    });

    const unpack = el.querySelector('#unpack');
    if (unpack) unpack.addEventListener('click', async () => {
      try {
        await api(`/dispatches/${id}/status`, { method: 'POST', body: JSON.stringify({ status: 'picking' }) });
        await detail(el, id);
      } catch (e) { alert(e.message); }
    });

    const pod = el.querySelector('#pod');
    if (pod) pod.addEventListener('click', async () => {
      try {
        await api(`/dispatches/${id}/pod`, { method: 'POST', body: JSON.stringify({ received: !d.pod_received }) });
        await detail(el, id);
      } catch (e) { alert(e.message); }
    });

    const discard = el.querySelector('#discard');
    if (discard) discard.addEventListener('click', async () => {
      if (!window.confirm(`Discard ${d.dispatch_number}? Nothing has moved, so the stock simply goes back to outstanding.`)) return;
      try {
        await api(`/dispatches/${id}`, { method: 'DELETE' });
        location.hash = '#/dispatch';
      } catch (e) { alert(e.message); }
    });
  }

  draw();
}
