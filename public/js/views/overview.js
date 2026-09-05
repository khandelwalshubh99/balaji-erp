import { api, html, raw, card, kpi, money, count, qty, shortDate, ago, sparkline, bar, emptyState } from '../util.js';

export const title = 'Overview';

export async function render(el) {
  const d = await api('/overview');

  const stale =
    d.lastSync && d.lastSync.status !== 'ok'
      ? `<div class="callout warn"><strong>Last sync was ${d.lastSync.status}.</strong>
         Some figures below may be from an earlier pull — check the Tally connection page before acting on them.</div>`
      : '';

  const trendValues = d.sales.trend.map((t) => t.amount);
  const catMax = Math.max(1, ...d.sales.byCategory.map((c) => c.amount));

  el.innerHTML = html`
    ${raw(stale)}
    <div class="grid cols-4" style="margin-bottom:14px">
      ${raw(kpi({
        label: 'Stock on hand',
        value: money(d.stock.value),
        sub: `${count(d.stock.items)} items · ${count(d.stock.low_stock)} low · ${count(d.stock.out_of_stock)} out`,
      }))}
      ${raw(kpi({
        label: 'Receivables',
        value: money(d.receivables.total),
        sub: `${count(d.receivables.billCount)} bills across ${count(d.receivables.partyCount)} customers`,
      }))}
      ${raw(kpi({
        label: 'Overdue',
        value: money(d.receivables.overdue),
        tone: d.receivables.overdue > 0 ? 'bad' : '',
        sub: `${((d.receivables.overdue / (d.receivables.total || 1)) * 100).toFixed(0)}% of what's outstanding`,
      }))}
      ${raw(kpi({
        label: 'Pending dispatch',
        value: count(d.orders.pending.count),
        tone: d.orders.pending.agedOver3Days > 0 ? 'warn' : '',
        sub: `${money(d.orders.pending.value)} · ${count(d.orders.pending.agedOver3Days)} older than 3 days`,
      }))}
    </div>

    <div class="grid cols-2" style="margin-bottom:14px">
      ${raw(card(
        'Sales, last 30 days',
        html`<div style="font-size:24px;font-weight:640;letter-spacing:-0.02em">${raw(money(d.sales.last30))}</div>
          <div class="sub faint" style="font-size:12.5px;margin-bottom:10px">
            ${count(d.orders.ordersToday)} orders today · ${count(d.orders.dispatchedToday)} dispatched · ${count(d.orders.invoicedToday)} invoiced
          </div>
          ${raw(sparkline(trendValues))}`,
        { note: 'from Tally sales vouchers' }
      ))}

      ${raw(card(
        'Receivables ageing',
        html`<div class="ageing">
          ${raw(
            d.receivables.buckets
              .map((b) => {
                const frac = b.amount / (d.receivables.total || 1);
                const tone = b.key === '90+' ? 'var(--bad)' : b.key === '61-90' ? 'var(--warn)' : 'var(--accent)';
                return `<div class="ageing-row">
                  <span class="dim">${b.label}</span>
                  ${bar(frac, tone)}
                  <span class="amt">${money(b.amount)}</span>
                </div>`;
              })
              .join('')
          )}
        </div>`,
        { note: 'by bill date' }
      ))}
    </div>

    <div class="grid cols-2" style="margin-bottom:14px">
      ${raw(card(
        'Orders sitting in dispatch',
        d.orders.stuck.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>Order</th><th>Customer</th><th class="num">Value</th><th class="num">Age</th></tr></thead>
              <tbody>${d.orders.stuck
                .map(
                  (o) => `<tr>
                    <td class="mono nowrap">${o.voucher_number}</td>
                    <td class="truncate">${o.party_name}</td>
                    <td class="num">${money(o.amount)}</td>
                    <td class="num ${o.age_days > 7 ? 'bad' : ''}">${o.age_days}d</td>
                  </tr>`
                )
                .join('')}</tbody></table></div>`
          : emptyState('Nothing pending more than 3 days.'),
        { flush: true, note: 'no delivery note against the sales order yet' }
      ))}

      ${raw(card(
        'At or below reorder level',
        d.reorder.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>Item</th><th class="num">On hand</th><th class="num">Reorder at</th></tr></thead>
              <tbody>${d.reorder
                .map(
                  (r) => `<tr>
                    <td class="truncate" title="${r.name}">${r.name}</td>
                    <td class="num ${r.closing_qty <= 0 ? 'bad' : 'warn'}">${qty(r.closing_qty)} ${r.base_units}</td>
                    <td class="num dim">${qty(r.effective_level)}</td>
                  </tr>`
                )
                .join('')}</tbody></table></div>`
          : emptyState('Nothing below reorder level.'),
        { flush: true }
      ))}
    </div>

    <div class="grid cols-2">
      ${raw(card(
        'Sales by category, last 30 days',
        d.sales.byCategory.length
          ? `<div class="ageing">${d.sales.byCategory
              .map(
                (c) => `<div class="ageing-row">
                  <span class="dim truncate" style="max-width:92px" title="${c.category}">${c.category}</span>
                  ${bar(c.amount / catMax)}
                  <span class="amt">${money(c.amount)}</span>
                </div>`
              )
              .join('')}</div>`
          : emptyState('No sales in the window.')
      ))}

      ${raw(card(
        'Who owes the most',
        d.receivables.topParties.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>Customer</th><th class="num">Outstanding</th><th class="num">Overdue</th><th class="num">Oldest</th></tr></thead>
              <tbody>${d.receivables.topParties
                .map(
                  (p) => `<tr>
                    <td class="truncate" title="${p.party_name}">${p.party_name}</td>
                    <td class="num">${money(p.total)}</td>
                    <td class="num ${p.overdue > 0 ? 'bad' : 'faint'}">${p.overdue > 0 ? money(p.overdue) : '—'}</td>
                    <td class="num dim">${p.oldest_days}d</td>
                  </tr>`
                )
                .join('')}</tbody></table></div>`
          : emptyState('No outstanding bills.'),
        { flush: true }
      ))}
    </div>

    <p class="faint" style="margin-top:18px;font-size:12px">
      Mirrored from Tally ${raw(d.lastSync ? ago(d.lastSync.finished_at) : 'never')}. Tally stays the system of record —
      nothing on this screen is written back.
    </p>
  `;
}
