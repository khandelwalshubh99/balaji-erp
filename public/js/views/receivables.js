import { api, html, raw, card, kpi, money, count, shortDate, bar, emptyState } from '../util.js';

export const title = 'Receivables';

export async function render(el) {
  const d = await api('/receivables');
  let expanded = null;

  const partyRows = () =>
    d.parties
      .map((p) => {
        const open = expanded === p.party_name;
        const detail = open
          ? `<tr><td colspan="7" style="padding:0;background:var(--surface-2)">
              <table><thead><tr>
                <th>Bill</th><th>Date</th><th>Due</th><th class="num">Age</th><th class="num">Overdue by</th><th class="num">Amount</th>
              </tr></thead><tbody>
              ${d.bills
                .filter((b) => b.party_name === p.party_name)
                .map(
                  (b) => `<tr>
                    <td class="mono nowrap">${b.bill_ref}</td>
                    <td class="dim nowrap">${shortDate(b.bill_date)}</td>
                    <td class="dim nowrap">${shortDate(b.due_date)}</td>
                    <td class="num dim">${b.age_days}d</td>
                    <td class="num ${b.is_overdue ? 'bad' : 'faint'}">${b.is_overdue ? `${b.days_overdue}d` : '—'}</td>
                    <td class="num">${money(b.amount)}</td>
                  </tr>`
                )
                .join('')}
              </tbody></table></td></tr>`
          : '';
        const limitCell =
          p.credit_limit > 0
            ? `<td class="num ${p.total > p.credit_limit ? 'bad' : 'dim'}">${money(p.credit_limit)}</td>`
            : '<td class="num faint">—</td>';
        return `<tr data-party="${p.party_name}" style="cursor:pointer">
            <td>${open ? '▾' : '▸'} ${p.party_name}</td>
            <td class="num dim">${p.bills}</td>
            <td class="num">${money(p.total)}</td>
            <td class="num ${p.overdue > 0 ? 'bad' : 'faint'}">${p.overdue > 0 ? money(p.overdue) : '—'}</td>
            <td class="num dim">${p.oldest_days}d</td>
            ${limitCell}
            <td>${
              p.credit_limit > 0 && p.total > p.credit_limit
                ? '<span class="pill bad">Over limit</span>'
                : p.overdue > 0
                ? '<span class="pill warn">Overdue</span>'
                : '<span class="pill ok">Within terms</span>'
            }</td>
          </tr>${detail}`;
      })
      .join('');

  const draw = () => {
    el.innerHTML = html`
      <div class="grid cols-4" style="margin-bottom:14px">
        ${raw(kpi({ label: 'Total outstanding', value: money(d.total), sub: `${count(d.billCount)} open bills` }))}
        ${raw(kpi({ label: 'Overdue', value: money(d.overdue), tone: d.overdue ? 'bad' : '', sub: 'past agreed credit period' }))}
        ${raw(kpi({ label: 'Customers owing', value: count(d.partyCount), sub: 'with at least one open bill' }))}
        ${raw(kpi({
          label: 'Over 90 days',
          value: money(d.buckets[3].amount),
          tone: d.buckets[3].amount ? 'bad' : '',
          sub: `${count(d.buckets[3].bills)} bills`,
        }))}
      </div>

      ${raw(card(
        'Ageing',
        `<div class="ageing">${d.buckets
          .map((b) => {
            const tone = b.key === '90+' ? 'var(--bad)' : b.key === '61-90' ? 'var(--warn)' : 'var(--accent)';
            return `<div class="ageing-row">
              <span class="dim">${b.label}</span>
              ${bar(b.amount / (d.total || 1), tone)}
              <span class="amt">${money(b.amount)} <span class="faint" style="font-weight:400">· ${b.bills}</span></span>
            </div>`;
          })
          .join('')}</div>`,
        { note: 'measured from bill date' }
      ))}

      <div style="height:14px"></div>

      ${raw(card(
        'By customer',
        d.parties.length
          ? `<div class="table-wrap"><table>
              <thead><tr>
                <th>Customer</th><th class="num">Bills</th><th class="num">Outstanding</th>
                <th class="num">Overdue</th><th class="num">Oldest</th><th class="num">Credit limit</th><th></th>
              </tr></thead>
              <tbody>${partyRows()}</tbody></table></div>`
          : emptyState('No outstanding bills in the synced data.'),
        { flush: true, note: 'click a row for the bill-by-bill breakdown' }
      ))}

      <div class="callout" style="margin-top:16px">
        Credit limits shown here are whatever is set on the ledger in Tally. Phase 4 turns them into a hard
        check before an order can be cleared — right now they are only reported.
      </div>
    `;

    el.querySelectorAll('tr[data-party]').forEach((row) =>
      row.addEventListener('click', () => {
        expanded = expanded === row.dataset.party ? null : row.dataset.party;
        draw();
      })
    );
  };

  draw();
}
