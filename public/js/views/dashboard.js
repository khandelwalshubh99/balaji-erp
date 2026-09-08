import {
  api, html, raw, card, kpi, money, rupees, count, qty, shortDate,
  sparkline, bar, emptyState, esc,
} from '../util.js';

export const title = 'Dashboard';

const TIER_TONE = { platinum: 'accent', gold: 'ok', silver: '', bronze: '' };
const UNASSIGNED = 'Unassigned';

/**
 * A stable colour per industry, picked from the label itself.
 *
 * Not stored anywhere: the list of segments is whatever people have typed, so
 * there is nothing to hold a colour against. Hashing the name means Automobile
 * is the same colour on every screen and after every new segment is added,
 * which is the only property that matters here.
 */
const segmentHue = (label) => {
  let h = 0;
  for (let i = 0; i < label.length; i += 1) h = (h * 31 + label.charCodeAt(i)) % 360;
  return h;
};
const segmentStyle = (label) =>
  label === UNASSIGNED
    ? ''
    : `background:hsl(${segmentHue(label)} 62% 92%);color:hsl(${segmentHue(label)} 72% 26%)`;

const monthLabel = (m) => {
  const [y, mm] = String(m).split('-').map(Number);
  return new Date(y, mm - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
};
const monthLong = (m) => {
  const [y, mm] = String(m).split('-').map(Number);
  return new Date(y, mm - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
};

/**
 * A ratio is only meaningful against something at both ends.
 *
 * `0.00×` is a real answer to "we quoted nothing and billed plenty", but it is
 * indistinguishable on a screen from "we have not started recording quotes",
 * which is the situation until quoting moves into this app. So a month with no
 * quotations at all reads as a dash, and the callout above says why.
 */
const ratioText = (m) => {
  if (!m || m.ratio === null || m.ratio === undefined) return '—';
  if (!m.quotations) return '—';
  return `${m.ratio.toFixed(2)}×`;
};

const pct = (n) => `${(n * 100).toFixed(n >= 0.1 ? 0 : 1)}%`;

export async function render(el) {
  const state = {
    month: '',
    window: 6,
    tier: '',
    segment: '',
    search: '',
    showAll: false,
  };
  let d = null;
  let brands = null;
  let knownSegments = [];

  async function load() {
    const qs = new URLSearchParams({ window: String(state.window) });
    if (state.month) qs.set('month', state.month);
    d = await api(`/dashboard?${qs}`);
    state.month = d.month;
    brands = await api(`/dashboard/brands?month=${d.month}&months=${state.window}`);
    knownSegments = (await api('/customer-segments')).known.all;
  }

  // --- pieces ---------------------------------------------------------------
  function toolbar() {
    const options = d.monthsAvailable
      .map((m) => `<option value="${m}" ${m === d.month ? 'selected' : ''}>${esc(monthLong(m))}</option>`)
      .join('');
    const windows = [3, 6, 12]
      .map((w) => `<option value="${w}" ${w === state.window ? 'selected' : ''}>${w} months</option>`)
      .join('');
    return `<div class="toolbar">
      <label class="dim" style="font-size:12.5px">Month</label>
      <select id="month">${options}</select>
      <label class="dim" style="font-size:12.5px">Scoring window</label>
      <select id="window">${windows}</select>
      <span class="spacer" style="flex:1"></span>
      <span class="faint" style="font-size:12px">
        Tiers as at the end of ${esc(monthLabel(d.month))}, over ${d.window.months} months
        (${esc(shortDate(d.window.from))} – ${esc(shortDate(d.window.to))})
      </span>
    </div>`;
  }

  function headline() {
    const h = d.headline;
    const prev = d.months[d.months.length - 2];
    const thisMonth = d.months[d.months.length - 1];
    const partial = d.isCurrentMonth
      ? `month to date · ${esc(shortDate(d.today))}`
      : 'full month';
    // A part month against a whole one is not a comparison, so the previous
    // month is offered as a reference figure instead of a delta until the
    // month being shown has actually finished.
    const versusPrev = !prev || !prev.customersBilled
      ? `of ${count(h.customersInWindow)} on the book`
      : d.isCurrentMonth
      ? `${count(prev.customersBilled)} in ${esc(monthLabel(prev.month))} · ${count(h.customersInWindow)} on the book`
      : `${h.customersBilled - prev.customersBilled >= 0 ? '+' : ''}${h.customersBilled - prev.customersBilled} on ${esc(monthLabel(prev.month))} · ${count(h.customersInWindow)} on the book`;

    return `<div class="grid cols-4" style="margin-bottom:14px">
      ${kpi({
        label: 'Billed',
        value: money(h.billedValue),
        sub: `${count(h.billedInvoices)} sales invoices · ${partial}`,
      })}
      ${kpi({
        label: 'Quoted',
        value: money(h.quotedValue),
        sub: h.quotations
          ? `${count(h.quotations)} quotations issued`
          : 'no quotations recorded this month',
        tone: h.quotations ? '' : 'warn',
      })}
      ${kpi({
        label: 'Quoted / billed',
        value: ratioText(thisMonth),
        sub: h.quotations
          ? 'value quoted for every rupee billed'
          : 'nothing to compare yet',
      })}
      ${kpi({
        label: 'Customers billed',
        value: count(h.customersBilled),
        sub: versusPrev,
      })}
    </div>`;
  }

  function quotedVsBilled() {
    const rows = d.months.filter((m) => m.billedValue || m.quotedValue);
    const anyQuotes = d.months.some((m) => m.quotations > 0);
    const max = Math.max(1, ...rows.map((m) => Math.max(m.billedValue, m.quotedValue)));

    const note = anyQuotes
      ? ''
      : `<div class="callout warn" style="margin:0 16px 14px">
          <strong>No quotations have been recorded yet.</strong>
          The billed side comes from Tally, but the quoted side can only come from quotations raised
          in this app — Tally has no record that a quotation exists. Until quoting moves onto this
          screen the ratio has nothing to divide by, and the two lists at the bottom will name every
          high-tier customer rather than the ones actually missed.
        </div>`;

    const body = rows.length
      ? `${note}<div class="table-wrap"><table>
          <thead><tr>
            <th>Month</th><th class="num">Quoted</th><th class="num">Billed</th>
            <th style="width:190px"></th>
            <th class="num">Quoted / billed</th><th class="num">Customers billed</th><th class="num">Invoices</th>
          </tr></thead>
          <tbody>${rows
            .map((m) => {
              const isSel = m.month === d.month;
              return `<tr class="${isSel ? 'row-selected' : ''}">
                <td class="nowrap">${esc(monthLabel(m.month))}${isSel && d.isCurrentMonth ? ' <span class="faint">(to date)</span>' : ''}</td>
                <td class="num nowrap ${m.quotedValue ? '' : 'faint'}">${m.quotedValue ? money(m.quotedValue) : '—'}</td>
                <td class="num nowrap">${money(m.billedValue)}</td>
                <td>
                  <div class="dual-bar">
                    ${bar(m.quotedValue / max, 'var(--warn)')}
                    ${bar(m.billedValue / max, 'var(--accent)')}
                  </div>
                </td>
                <td class="num nowrap ${m.quotations ? '' : 'faint'}">${ratioText(m)}</td>
                <td class="num">${count(m.customersBilled)}</td>
                <td class="num dim">${count(m.billedInvoices)}</td>
              </tr>`;
            })
            .join('')}</tbody></table></div>`
      : emptyState('Nothing billed or quoted in this window.');

    return card('Quoted against billed', body, {
      flush: true,
      note: 'quoted bar in amber, billed in blue',
    });
  }

  function brandTable() {
    const rows = brands.brands.filter((b) => b.monthValue > 0 || b.value > 0);
    const body = rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr>
            <th>Brand</th><th class="num">${esc(monthLabel(d.month))}</th>
            <th style="width:150px">Share</th>
            <th class="num">Customers</th><th class="num">Invoices</th>
            <th class="num">${brands.months.length}-month total</th>
            <th style="width:110px">Trend</th>
          </tr></thead>
          <tbody>${rows
            .map(
              (b) => `<tr>
                <td>${esc(b.brand)}</td>
                <td class="num nowrap ${b.monthValue ? '' : 'faint'}">${b.monthValue ? money(b.monthValue) : '—'}</td>
                <td>
                  <div class="share-cell">${bar(b.share)}<span class="faint">${b.monthValue ? pct(b.share) : '—'}</span></div>
                </td>
                <td class="num ${b.customers ? 'dim' : 'faint'}">${b.customers || '—'}</td>
                <td class="num ${b.invoices ? 'dim' : 'faint'}">${b.invoices || '—'}</td>
                <td class="num nowrap dim">${money(b.value)}</td>
                <td><div class="minispark">${sparkline(b.trend, { height: 26 })}</div></td>
              </tr>`
            )
            .join('')}</tbody></table></div>`
      : emptyState('No billed lines in this window.');

    const unmapped = brands.unmappedValue
      ? `${money(brands.unmappedValue)} of this month is on items not matched to the catalogue`
      : 'every billed line matched to a catalogue brand';

    return card('Brand-wise sales', body, { flush: true, note: unmapped });
  }

  function tierCards() {
    return `<div class="grid cols-4" style="margin-bottom:14px">
      ${d.tiers.bands
        .map(
          (b) => `<div class="card kpi tier-card ${state.tier === b.key ? 'selected' : ''}" data-tier="${b.key}">
            <div class="label"><span class="pill ${TIER_TONE[b.key] || ''}">${esc(b.label)}</span></div>
            <div class="value">${count(b.customers)}</div>
            <div class="sub">${money(b.value)} over the window</div>
            <div class="faint" style="font-size:11.5px;margin-top:5px">${esc(b.note)}</div>
          </div>`
        )
        .join('')}
    </div>`;
  }

  function segmentTable() {
    const t = d.segmentTotals;
    const rows = d.segments;

    const body = rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr>
            <th>Segment</th><th class="num">${esc(monthLabel(d.month))}</th>
            <th style="width:150px">Share</th>
            <th class="num">Customers billed</th><th class="num">Invoices</th>
            <th class="num">On the book</th>
            <th class="num">${t.months.length}-month total</th>
            <th style="width:110px">Trend</th>
          </tr></thead>
          <tbody>${rows
            .map(
              (seg) => `<tr class="seg-row ${state.segment === seg.segment ? 'row-selected' : ''}" data-segment="${esc(seg.segment)}">
                <td><span class="pill" style="${segmentStyle(seg.segment)}">${esc(seg.segment)}</span></td>
                <td class="num nowrap ${seg.monthValue ? '' : 'faint'}">${seg.monthValue ? money(seg.monthValue) : '—'}</td>
                <td>
                  <div class="share-cell">${bar(seg.share)}<span class="faint">${seg.monthValue ? pct(seg.share) : '—'}</span></div>
                </td>
                <td class="num ${seg.customers ? 'dim' : 'faint'}">${seg.customers || '—'}</td>
                <td class="num ${seg.invoices ? 'dim' : 'faint'}">${seg.invoices || '—'}</td>
                <td class="num dim">${count(seg.customersInBook)}</td>
                <td class="num nowrap dim">${money(seg.value)}</td>
                <td><div class="minispark">${sparkline(seg.trend, { height: 26 })}</div></td>
              </tr>`
            )
            .join('')}</tbody></table></div>`
      : emptyState('Nothing billed in this window.');

    // Until customers have been categorised this card is one row saying
    // "Unassigned", which is honest but useless. Say what to do about it
    // rather than leaving somebody to conclude the feature is broken.
    const nudge = t.unassignedCustomers
      ? `<div class="callout ${t.assignedCustomers ? '' : 'warn'}" style="margin:0 16px 14px">
          <strong>${count(t.unassignedCustomers)} of ${count(t.unassignedCustomers + t.assignedCustomers)}
          customers have no industry against them${t.unassignedValue ? `, covering ${esc(money(t.unassignedValue))} of this month` : ''}.</strong>
          Tally has nowhere to record what a customer makes — its ledger groups here are salesmen and
          territory — so this is the app's own record. Set it in the <em>Segment</em> column of the
          customer table below; it is remembered per customer and only has to be done once. With a
          Google Sheet connected they can also be filled in down the <em>Customer Segments</em> tab.
        </div>`
      : '';

    return card('Sales by segment', `${nudge}${body}`, {
      flush: true,
      note: 'industry of the customer billed · click a row to filter the table below',
    });
  }

  /**
   * The customer table's frame, rendered once.
   *
   * Only the body below is redrawn when a filter changes. Rebuilding the whole
   * screen on every keystroke would take the search box out from under the
   * cursor mid-word, and the caret-restoring workaround for that is worse than
   * simply not throwing the input away.
   */
  function customerShell() {
    return `<section class="card">
      <header>
        <h2>Customers — <span id="cust-count">${d.tiers.customers.length}</span> of ${d.tiers.customers.length}</h2>
        <div class="spacer"></div>
        <span class="note">scored against the rest of the book, not against a fixed rupee figure</span>
        <input type="search" id="cust-search" placeholder="Filter customers" value="${esc(state.search)}" />
        <button class="btn small" id="clear-filters" hidden></button>
      </header>
      <div class="body flush" id="cust-body"></div>
    </section>`;
  }

  function filteredCustomers() {
    const term = state.search.trim().toLowerCase();
    let rows = d.tiers.customers;
    if (state.tier) rows = rows.filter((r) => r.tier === state.tier);
    if (state.segment) rows = rows.filter((r) => r.segment === state.segment);
    if (term) rows = rows.filter((r) => r.customer.toLowerCase().includes(term));
    return rows;
  }

  /**
   * The segment cell: a dropdown of what is already known, plus a way in for
   * one that is not.
   *
   * A dropdown rather than a text box because the whole value of this field is
   * that it groups, and free typing produces "Automobile", "automobile" and
   * "Auto" as three industries within a week. Anything genuinely new can still
   * be added — it just has to be a deliberate act rather than a typo.
   */
  function segmentPicker(r) {
    const options = knownSegments
      .map((seg) => `<option value="${esc(seg)}" ${seg === r.segment ? 'selected' : ''}>${esc(seg)}</option>`)
      .join('');
    return `<select class="seg-pick" data-customer="${esc(r.customer)}"
              style="${segmentStyle(r.segment)}" title="Industry — saved against this customer">
      <option value="" ${r.segment === UNASSIGNED ? 'selected' : ''}>— Unassigned —</option>
      ${options}
      <option value="__new__">+ New segment…</option>
    </select>`;
  }

  async function saveSegment(select) {
    const customer = select.dataset.customer;
    const previous = d.tiers.customers.find((c) => c.customer === customer)?.segment || UNASSIGNED;
    let value = select.value;

    if (value === '__new__') {
      const typed = window.prompt(`Industry for ${customer}`, '');
      if (typed === null || !typed.trim()) {
        select.value = previous === UNASSIGNED ? '' : previous;
        return;
      }
      value = typed.trim();
    }

    select.disabled = true;
    try {
      const out = await api('/customer-segments', {
        method: 'PUT',
        body: JSON.stringify({ customerName: customer, segment: value }),
      });
      knownSegments = out.known.all;
      // Reloaded rather than patched in place: the segment changes what every
      // total on the card above is made of, and showing a new label beside
      // stale sales figures is the kind of half-update people stop trusting.
      await load();
      draw();
    } catch (err) {
      select.disabled = false;
      select.value = previous === UNASSIGNED ? '' : previous;
      window.alert(err.message);
    }
  }

  function fillCustomers() {
    const rows = filteredCustomers();
    const shown = state.showAll ? rows : rows.slice(0, 25);

    el.querySelector('#cust-count').textContent = String(rows.length);

    const filters = [
      state.tier ? d.tiers.bands.find((b) => b.key === state.tier)?.label : null,
      state.segment || null,
    ].filter(Boolean);
    const clear = el.querySelector('#clear-filters');
    clear.hidden = filters.length === 0;
    clear.textContent = filters.length ? `Clear ${filters.join(' + ')}` : '';

    el.querySelector('#cust-body').innerHTML = shown.length
      ? `<div class="table-wrap"><table>
          <thead><tr>
            <th>Customer</th><th>Tier</th><th>Segment</th>
            <th class="num" title="Distinct brands bought in the window">Brands</th>
            <th class="num" title="Sales invoices per month">Invoices / mo</th>
            <th class="num" title="Billed value per month">Value / mo</th>
            <th class="num" title="Brands · frequency · value, each scored 1–5 against the rest of the book">Score</th>
            <th class="num">Window value</th><th class="num">Last billed</th>
          </tr></thead>
          <tbody>${shown
            .map(
              (r) => `<tr>
                <td class="truncate" title="${esc(r.customer)}">${esc(r.customer)}</td>
                <td><span class="pill ${TIER_TONE[r.tier] || ''}">${esc(r.tier_label)}</span></td>
                <td class="seg-cell">${segmentPicker(r)}</td>
                <td class="num">${count(r.brands)}</td>
                <td class="num">${qty(r.frequency)}</td>
                <td class="num nowrap">${money(r.monetary)}</td>
                <td class="num mono nowrap" title="Brands ${r.brands_score} · frequency ${r.frequency_score} · value ${r.monetary_score}">
                  ${r.brands_score}·${r.frequency_score}·${r.monetary_score}
                  <span class="faint">= ${r.score}</span>
                </td>
                <td class="num nowrap">${money(r.value)}</td>
                <td class="num nowrap ${r.days_since_billed > 60 ? 'warn' : 'dim'}">
                  ${esc(shortDate(r.last_billed))} <span class="faint">${r.days_since_billed}d</span>
                </td>
              </tr>`
            )
            .join('')}</tbody></table>
          ${rows.length > shown.length
            ? `<div style="padding:10px 16px"><button class="btn small" id="show-all">Show all ${rows.length}</button></div>`
            : ''}
        </div>`
      : emptyState('No customers match that filter.');

    el.querySelector('#show-all')?.addEventListener('click', () => {
      state.showAll = true;
      fillCustomers();
    });

    el.querySelectorAll('.seg-pick').forEach((sel) =>
      sel.addEventListener('change', () => saveSegment(sel))
    );
  }

  function gapCard(key, heading, note, emptyMsg) {
    const rows = d.gaps[key];
    const body = rows.length
      ? `<div class="table-wrap" style="max-height:420px"><table>
          <thead><tr>
            <th>Customer</th><th>Tier</th><th class="num">Typical / month</th>
            <th class="num">Last billed</th>
          </tr></thead>
          <tbody>${rows
            .map(
              (r) => `<tr>
                <td class="truncate" title="${esc(r.customer)}">${esc(r.customer)}</td>
                <td><span class="pill ${TIER_TONE[r.tier] || ''}">${esc(r.tier_label)}</span></td>
                <td class="num nowrap">${money(r.avg_month_value)}</td>
                <td class="num nowrap ${r.days_since_billed > 45 ? 'bad' : 'dim'}">
                  ${esc(shortDate(r.last_billed))} <span class="faint">${r.days_since_billed}d</span>
                </td>
              </tr>`
            )
            .join('')}</tbody></table></div>`
      : emptyState(emptyMsg);

    const exposure = rows.reduce((n, r) => n + r.avg_month_value, 0);
    return card(heading, body, {
      flush: true,
      note: rows.length ? `${count(rows.length)} customers · ${money(exposure)} of a typical month` : note,
    });
  }

  // --- draw -----------------------------------------------------------------
  function draw() {
    el.innerHTML = html`
      ${raw(toolbar())}
      ${raw(headline())}
      ${raw(quotedVsBilled())}
      <div style="height:14px"></div>
      ${raw(brandTable())}
      <div style="height:14px"></div>
      ${raw(tierCards())}
      ${raw(segmentTable())}
      <div style="height:14px"></div>
      ${raw(customerShell())}
      <div style="height:14px"></div>
      <div class="grid cols-2">
        ${raw(gapCard(
          'notBilled',
          `High-tier customers not billed in ${monthLabel(d.month)}`,
          'Every high-tier customer was billed this month.',
          'Every high-tier customer has been billed this month.'
        ))}
        ${raw(gapCard(
          'notQuoted',
          `High-tier customers not quoted in ${monthLabel(d.month)}`,
          'Every high-tier customer was quoted this month.',
          'Every high-tier customer has been quoted this month.'
        ))}
      </div>

      <p class="faint" style="margin-top:18px;font-size:12px">
        Billed figures are Tally sales vouchers from the synced mirror. Quoted figures are quotations
        raised in this app, current version only, drafts excluded. Tiers are relative: a customer is
        Platinum because of where they sit against the rest of the book on brands bought, how often
        they buy and what they are worth — not against a fixed rupee figure. Segment is the customer's
        industry, kept here because Tally has nowhere to record it, and set by hand once per customer.
      </p>
    `;

    // --- wiring
    el.querySelector('#month').addEventListener('change', async (e) => {
      state.month = e.target.value;
      state.showAll = false;
      el.innerHTML = '<div class="loading">Loading…</div>';
      await load();
      draw();
    });

    el.querySelector('#window').addEventListener('change', async (e) => {
      state.window = Number(e.target.value);
      el.innerHTML = '<div class="loading">Loading…</div>';
      await load();
      draw();
    });

    const syncSelection = () => {
      el.querySelectorAll('[data-tier]').forEach((c) =>
        c.classList.toggle('selected', c.dataset.tier === state.tier)
      );
      el.querySelectorAll('[data-segment]').forEach((c) =>
        c.classList.toggle('row-selected', c.dataset.segment === state.segment)
      );
      state.showAll = false;
      fillCustomers();
    };

    el.querySelectorAll('[data-tier]').forEach((c) =>
      c.addEventListener('click', () => {
        state.tier = state.tier === c.dataset.tier ? '' : c.dataset.tier;
        syncSelection();
      })
    );

    el.querySelectorAll('[data-segment]').forEach((c) =>
      c.addEventListener('click', () => {
        state.segment = state.segment === c.dataset.segment ? '' : c.dataset.segment;
        syncSelection();
      })
    );

    el.querySelector('#clear-filters').addEventListener('click', () => {
      state.tier = '';
      state.segment = '';
      syncSelection();
    });

    const search = el.querySelector('#cust-search');
    search.addEventListener('input', () => {
      state.search = search.value;
      state.showAll = false;
      fillCustomers();
    });

    fillCustomers();
  }

  await load();
  draw();
}
