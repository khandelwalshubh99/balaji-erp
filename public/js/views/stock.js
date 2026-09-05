import { api, html, raw, card, kpi, money, count, qty, rupees, emptyState } from '../util.js';

export const title = 'Stock';

const state = { search: '', category: '', status: 'all', sort: 'name' };

export async function render(el) {
  el.innerHTML = '<div class="loading">Loading stock…</div>';
  const first = await load();
  el.innerHTML = html`
    <div class="grid cols-4" style="margin-bottom:14px">
      ${raw(kpi({ label: 'Items', value: count(first.summary.items), sub: 'synced from Tally' }))}
      ${raw(kpi({ label: 'Stock value', value: money(first.summary.value), sub: 'at Tally closing rate' }))}
      ${raw(kpi({ label: 'Low stock', value: count(first.summary.low_stock), tone: 'warn', sub: 'at or below reorder level' }))}
      ${raw(kpi({ label: 'Out of stock', value: count(first.summary.out_of_stock), tone: first.summary.out_of_stock ? 'bad' : '', sub: 'nothing on hand' }))}
    </div>

    <div class="toolbar">
      <input type="search" id="q" placeholder="Search item, alias or part number…" value="${state.search}" />
      <select id="category">
        <option value="">All categories</option>
        ${raw(first.categories.map((c) => `<option value="${c.category}">${c.category} (${c.items})</option>`).join(''))}
      </select>
      <select id="status">
        <option value="all">Any stock level</option>
        <option value="low">Low stock only</option>
        <option value="out">Out of stock only</option>
        <option value="ok">Comfortable only</option>
      </select>
      <select id="sort">
        <option value="name">Sort: name</option>
        <option value="qty">Sort: lowest quantity</option>
        <option value="value">Sort: highest value</option>
        <option value="category">Sort: category</option>
      </select>
      <span class="spacer" style="flex:1"></span>
      <span class="pill" id="result-count"></span>
    </div>

    <div id="table-holder"></div>
  `;

  const holder = el.querySelector('#table-holder');
  const resultCount = el.querySelector('#result-count');

  const draw = (data) => {
    resultCount.textContent = `${count(data.rows.length)} of ${count(data.total)}`;
    holder.innerHTML = card(
      'Stock items',
      data.rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr>
              <th>Item</th><th>Category</th><th class="num">On hand</th>
              <th class="num">Reorder at</th><th class="num">Rate</th><th class="num">Value</th><th></th>
            </tr></thead>
            <tbody>${data.rows
              .map(
                (r) => `<tr>
                  <td><div class="truncate" title="${r.name}">${r.name}</div>
                      <div class="faint mono">${r.part_number || r.alias || ''}</div></td>
                  <td class="dim nowrap">${r.category || '—'}</td>
                  <td class="num">${qty(r.closing_qty)} <span class="faint">${r.base_units || ''}</span></td>
                  <td class="num dim">${qty(r.reorder_level)}</td>
                  <td class="num dim">${rupees(r.closing_rate)}</td>
                  <td class="num">${money(r.closing_value)}</td>
                  <td>${
                    r.stock_status === 'out'
                      ? '<span class="pill bad">Out</span>'
                      : r.stock_status === 'low'
                      ? '<span class="pill warn">Low</span>'
                      : '<span class="pill ok">OK</span>'
                  }</td>
                </tr>`
              )
              .join('')}</tbody></table></div>`
        : emptyState('No items match those filters.'),
      { flush: true, note: data.total > data.rows.length ? `showing first ${data.rows.length}` : '' }
    );
  };

  draw(first);

  let timer;
  const refresh = async () => {
    const data = await load();
    draw(data);
  };
  el.querySelector('#q').addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  });
  for (const id of ['category', 'status', 'sort']) {
    el.querySelector(`#${id}`).addEventListener('change', (e) => {
      state[id] = e.target.value;
      refresh();
    });
  }
}

function load() {
  const params = new URLSearchParams({ ...state, limit: '250' });
  return api(`/stock?${params}`);
}
