import { api, html, raw, card, kpi, money, count, qty, rupees, esc, emptyState } from '../util.js';

export const title = 'Catalogue';

const state = { search: '', brand: '', category: '', stocked: 'all', tab: 'browse' };

export async function render(el) {
  el.innerHTML = '<div class="loading">Loading catalogue…</div>';
  const first = await load();
  const s = first.summary;
  // The useful ratio is coverage of what Tally actually stocks, not of the
  // whole price list — most of the list is deliberately not stocked, so
  // "30% of the catalogue" reads as a failure when it is nothing of the sort.
  const stockedTotal = s.matched + s.orphanStock;
  const coverage = stockedTotal ? ((s.matched / stockedTotal) * 100).toFixed(1) : '0';

  el.innerHTML = html`
    <div class="grid cols-4" style="margin-bottom:14px">
      ${raw(kpi({ label: 'Catalogue items', value: count(s.total), sub: 'quotable SKUs from the price list' }))}
      ${raw(kpi({ label: 'Matched to Tally', value: count(s.matched), sub: `${coverage}% of everything Tally stocks` }))}
      ${raw(kpi({
        label: 'Not stocked',
        value: count(s.unmatched),
        sub: 'quotable, but no live stock figure',
      }))}
      ${raw(kpi({
        label: 'Stocked, not quotable',
        value: count(s.orphanStock),
        tone: s.orphanStock ? 'warn' : '',
        sub: 'in Tally, missing from the price list',
      }))}
    </div>

    <div class="toolbar">
      <input type="search" id="q" placeholder="Search 12,000+ SKUs — brand, part no, description…" value="${state.search}" />
      <select id="brand">
        <option value="">All brands</option>
        ${raw(first.brands.map((b) => `<option value="${esc(b.brand)}">${esc(b.brand)} (${b.n})</option>`).join(''))}
      </select>
      <select id="category">
        <option value="">All categories</option>
        ${raw(first.categories.map((c) => `<option value="${esc(c.category)}">${esc(c.category)} (${c.n})</option>`).join(''))}
      </select>
      <select id="stocked">
        <option value="all">Stocked or not</option>
        <option value="yes">Stocked in Tally only</option>
        <option value="no">Not stocked</option>
      </select>
      <span style="flex:1"></span>
      <button class="btn small" id="rematch">Re-run matching</button>
      <span class="pill" id="result-count"></span>
    </div>

    <div class="callout" style="margin-bottom:14px">
      The price list and the Tally stock master are two separately-maintained lists, so they are matched on
      part number first, then on the code appearing inside the Tally name, then on the description.
      Nothing is matched on a guess — a row showing <strong>not stocked</strong> can still be quoted, you just
      won't see a live stock figure against it.
    </div>

    <div id="holder"></div>
  `;

  const holder = el.querySelector('#holder');
  const resultCount = el.querySelector('#result-count');

  const draw = (data) => {
    resultCount.textContent = `${count(data.rows.length)} of ${count(data.total)}`;
    holder.innerHTML = card(
      'Catalogue',
      data.rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr>
              <th>Part no</th><th>Brand</th><th>Description</th><th>Category</th>
              <th class="num">List rate</th><th class="num">GST</th><th>HSN</th>
              <th class="num">In stock</th><th>Match</th>
            </tr></thead>
            <tbody>${data.rows
              .map((r) => {
                const stocked = r.match_method !== 'unmatched';
                return `<tr>
                  <td class="mono nowrap">${esc(r.code)}</td>
                  <td class="dim nowrap">${esc(r.brand)}</td>
                  <td><div class="truncate" title="${esc(r.name)}">${esc(r.name)}</div></td>
                  <td class="dim nowrap">${esc(r.category || '—')}</td>
                  <td class="num">${rupees(r.list_rate)}</td>
                  <td class="num dim">${r.gst_rate}%</td>
                  <td class="mono faint">${r.hsn || '<span class="pill warn">none</span>'}</td>
                  <td class="num">${
                    stocked
                      ? `${qty(r.closing_qty)} <span class="faint">${esc(r.base_units || '')}</span>`
                      : '<span class="faint">—</span>'
                  }</td>
                  <td>${
                    r.match_method === 'exact'
                      ? '<span class="pill ok">part no</span>'
                      : r.match_method === 'code-in-name'
                      ? '<span class="pill ok">in name</span>'
                      : r.match_method === 'name'
                      ? '<span class="pill accent">description</span>'
                      : r.match_method === 'manual'
                      ? '<span class="pill accent">manual</span>'
                      : '<span class="pill">not stocked</span>'
                  }</td>
                </tr>`;
              })
              .join('')}</tbody></table></div>`
        : emptyState('Nothing matches those filters.'),
      { flush: true, note: data.total > data.rows.length ? `showing first ${data.rows.length}` : '' }
    );
  };

  draw(first);

  let timer;
  const refresh = async () => draw(await load());
  el.querySelector('#q').addEventListener('input', (e) => {
    state.search = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  });
  for (const id of ['brand', 'category', 'stocked']) {
    el.querySelector(`#${id}`).addEventListener('change', (e) => {
      state[id] = e.target.value;
      refresh();
    });
  }
  el.querySelector('#rematch').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Matching…';
    await api('/catalogue/match', { method: 'POST' });
    render(el);
  });
}

function load() {
  return api(`/catalogue?${new URLSearchParams({ ...state, limit: '150' })}`);
}
