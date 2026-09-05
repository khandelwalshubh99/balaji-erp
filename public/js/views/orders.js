import { api, html, raw, card, kpi, money, count, shortDate, emptyState } from '../util.js';

export const title = 'Orders';

let windowDays = 45;
let filter = 'pending';

export async function render(el) {
  const d = await api(`/orders?days=${windowDays}`);

  const shown = d.orders.filter((o) =>
    filter === 'pending' ? o.is_pending : filter === 'dispatched' ? !o.is_pending : true
  );

  el.innerHTML = html`
    <div class="callout" style="margin-bottom:14px">
      <strong>This is inference, not a shared record.</strong> An order counts as dispatched here only because a
      delivery note in Tally quotes its sales-order number. If someone typed the reference differently, it will look
      pending forever. Phase 2 replaces this with an order that each department actually moves along.
    </div>

    <div class="grid cols-4" style="margin-bottom:14px">
      ${raw(kpi({ label: 'Orders today', value: count(d.ordersToday), sub: 'new sales orders in Tally' }))}
      ${raw(kpi({
        label: 'Pending dispatch',
        value: count(d.pending.count),
        tone: d.pending.agedOver3Days ? 'warn' : '',
        sub: `${money(d.pending.value)} of value waiting`,
      }))}
      ${raw(kpi({
        label: 'Waiting over 3 days',
        value: count(d.pending.agedOver3Days),
        tone: d.pending.agedOver3Days ? 'bad' : '',
        sub: `oldest is ${d.pending.oldestDays} days`,
      }))}
      ${raw(kpi({ label: 'Dispatched today', value: count(d.dispatchedToday), sub: `${count(d.invoicedToday)} invoiced today` }))}
    </div>

    <div class="toolbar">
      <select id="filter">
        <option value="pending">Pending dispatch</option>
        <option value="dispatched">Dispatched / invoiced</option>
        <option value="all">All orders</option>
      </select>
      <select id="days">
        <option value="15">Last 15 days</option>
        <option value="45">Last 45 days</option>
        <option value="90">Last 90 days</option>
      </select>
      <span style="flex:1"></span>
      <span class="pill">${count(shown.length)} orders</span>
    </div>

    <div id="holder"></div>
  `;

  el.querySelector('#filter').value = filter;
  el.querySelector('#days').value = String(windowDays);

  el.querySelector('#holder').innerHTML = card(
    'Order pipeline',
    shown.length
      ? `<div class="table-wrap"><table>
          <thead><tr>
            <th>Sales order</th><th>Date</th><th>Customer</th><th class="num">Lines</th>
            <th class="num">Value</th><th class="num">Age</th><th>Delivery note</th><th>Invoice</th><th>Stage</th>
          </tr></thead>
          <tbody>${shown
            .map(
              (o) => `<tr>
                <td class="mono nowrap">${o.voucher_number}</td>
                <td class="dim nowrap">${shortDate(o.date)}</td>
                <td class="truncate" title="${o.party_name}">${o.party_name}</td>
                <td class="num dim">${o.line_count}</td>
                <td class="num">${money(o.amount)}</td>
                <td class="num ${o.is_pending && o.age_days > 3 ? 'bad' : 'dim'}">${o.age_days}d</td>
                <td class="mono faint nowrap">${o.dispatch_number || '—'}</td>
                <td class="mono faint nowrap">${o.invoice_number || '—'}</td>
                <td>${
                  o.stage === 'Invoiced'
                    ? '<span class="pill ok">Invoiced</span>'
                    : o.stage === 'Dispatched'
                    ? '<span class="pill accent">Dispatched</span>'
                    : `<span class="pill ${o.age_days > 3 ? 'bad' : 'warn'}">Pending</span>`
                }</td>
              </tr>`
            )
            .join('')}</tbody></table></div>`
      : emptyState('No orders match.'),
    { flush: true }
  );

  el.querySelector('#filter').addEventListener('change', (e) => {
    filter = e.target.value;
    render(el);
  });
  el.querySelector('#days').addEventListener('change', (e) => {
    windowDays = Number(e.target.value);
    render(el);
  });
}
