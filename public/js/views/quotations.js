import { api, html, raw, card, money, rupees2, count, qty, shortDate, dateTime, esc, emptyState, todayISO, addDaysISO } from '../util.js';

export const title = 'Quotations';

const STATUS_TONE = { draft: '', sent: 'accent', accepted: 'ok', lost: 'bad', superseded: '' };

export async function render(el) {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  if (id === 'new') return composer(el, null);
  if (id) return composer(el, Number(id));
  return list(el);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
async function list(el) {
  const { quotations } = await api('/quotations');
  const byStatus = quotations.reduce((a, q) => ((a[q.status] = (a[q.status] || 0) + 1), a), {});

  el.innerHTML = html`
    <div class="toolbar">
      <button class="btn primary" id="new">New quotation</button>
      <span style="flex:1"></span>
      ${raw(['draft', 'sent', 'accepted', 'lost']
        .map((s) => `<span class="pill ${STATUS_TONE[s]}">${s} ${byStatus[s] || 0}</span>`)
        .join(' '))}
    </div>

    ${raw(card(
      'Quotations',
      quotations.length
        ? `<div class="table-wrap"><table>
            <thead><tr>
              <th>Number</th><th>Customer</th><th class="num">Lines</th><th class="num">Value</th>
              <th>Updated</th><th>Status</th>
            </tr></thead>
            <tbody>${quotations
              .map((q) => `<tr data-id="${q.id}" style="cursor:pointer">
                <td class="mono nowrap">${esc(q.quote_number)}${q.version > 1 ? ` <span class="faint">rev ${q.version}</span>` : ''}</td>
                <td class="truncate">${esc(q.customer_name)}</td>
                <td class="num dim">${q.line_count}</td>
                <td class="num">${money(q.total)}</td>
                <td class="dim nowrap">${dateTime(q.updated_at)}</td>
                <td><span class="pill ${STATUS_TONE[q.status] || ''}">${q.status}</span>${
                  q.status === 'lost' && q.lost_reason ? ` <span class="faint">${esc(q.lost_reason)}</span>` : ''
                }</td>
              </tr>`)
              .join('')}</tbody></table></div>`
        : emptyState('No quotations yet. Start one with “New quotation”.'),
      { flush: true }
    ))}
  `;

  el.querySelector('#new').addEventListener('click', () => {
    location.hash = '#/quotations?id=new';
  });
  el.querySelectorAll('tr[data-id]').forEach((row) =>
    row.addEventListener('click', () => {
      location.hash = `#/quotations?id=${row.dataset.id}`;
    })
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
async function composer(el, id) {
  el.innerHTML = '<div class="loading">Loading…</div>';

  const [{ customers }, { defaultTerms, validityDays }] = await Promise.all([
    api('/customers'),
    api('/quotations?limit=1'),
  ]);
  let quote = id ? await api(`/quotations/${id}`) : null;

  const model = {
    id: quote?.id ?? null,
    quoteNumber: quote?.quote_number ?? '(assigned on save)',
    version: quote?.version ?? 1,
    status: quote?.status ?? 'draft',
    customerName: quote?.customer_name ?? '',
    // A new quotation is dated today and stands for the standard validity
    // period, so neither field starts empty.
    quoteDate: quote?.quote_date ?? todayISO(),
    validUntil: quote?.valid_until ?? addDaysISO(todayISO(), validityDays),
    notes: quote?.notes ?? defaultTerms,
    lines: (quote?.lines ?? []).map((l) => ({
      itemName: l.item_name, itemCode: l.item_code, itemGuid: l.item_guid, brand: l.brand,
      hsn: l.hsn, qty: l.qty, units: l.units, listRate: l.list_rate,
      rate: l.rate, discountPct: l.discount_pct, gstRate: l.gst_rate, remarks: l.remarks || '',
    })),
    versions: quote?.versions ?? [],
  };

  let credit = null;
  const loadCredit = async () => {
    credit = model.customerName
      ? await api(`/customers/${encodeURIComponent(model.customerName)}/credit`).catch(() => null)
      : null;
  };
  await loadCredit();

  const readOnly = () => model.status !== 'draft';

  // Discount off the gross, GST on what is left — the same order the existing
  // quotation tool uses, and the same order the server recomputes on save.
  const n = (v) => Number(v) || 0;
  const taxableOf = (l) => n(l.qty) * n(l.rate) * (1 - n(l.discountPct) / 100);
  const gstOf = (l) => (taxableOf(l) * n(l.gstRate)) / 100;

  const lineTotals = () =>
    model.lines.reduce(
      (a, l) => {
        a.subtotal += taxableOf(l);
        a.tax += gstOf(l);
        return a;
      },
      { subtotal: 0, tax: 0 }
    );

  function draw() {
    const t = lineTotals();
    el.innerHTML = html`
      <div class="toolbar">
        <button class="btn small" id="back">← All quotations</button>
        <span class="pill mono">${model.quoteNumber}${raw(model.version > 1 ? ` · rev ${model.version}` : '')}</span>
        <span class="pill ${raw(STATUS_TONE[model.status] || '')}">${model.status}</span>
        <span style="flex:1"></span>
        <div class="status-bar" id="actions"></div>
      </div>

      ${raw(readOnly()
        ? `<div class="callout" style="margin-bottom:14px">
             This quotation has been sent, so it is locked — it is the record of what the customer was
             actually given. <strong>Revise</strong> creates version ${model.version + 1} and keeps this one readable.
           </div>`
        : '')}

      <div class="quote-grid">
        <div>
          ${raw(card(
            'Items',
            `${readOnly() ? '' : `<div class="searchbox" style="margin-bottom:12px">
                <input type="search" id="itemsearch" placeholder="Search 12,000+ SKUs — brand, part no, description…" autocomplete="off" />
                <div id="results"></div>
              </div>`}
             <div class="table-wrap" style="max-height:none">
               <table class="lines">
                 <thead><tr>
                   <th style="width:34px">#</th><th>Item</th><th style="width:80px" class="num">Qty</th>
                   <th style="width:60px">UoM</th><th style="width:100px" class="num">Rate</th>
                   <th style="width:70px" class="num">Disc %</th><th style="width:66px" class="num">GST %</th>
                   <th style="width:110px" class="num">Amount</th><th style="width:30px"></th>
                 </tr></thead>
                 <tbody id="lines"></tbody>
               </table>
             </div>`,
            { flush: false, note: `${model.lines.length} line${model.lines.length === 1 ? '' : 's'}` }
          ))}

          <div style="height:14px"></div>

          ${raw(card('Terms',
            `<textarea id="notes" ${readOnly() ? 'disabled' : ''}>${esc(model.notes)}</textarea>`
          ))}
        </div>

        <div>
          ${raw(card('Customer', `
            <div class="field">
              <label for="customer">Quoting to</label>
              <input list="customerlist" id="customer" value="${esc(model.customerName)}"
                     placeholder="Start typing a customer name" ${readOnly() ? 'disabled' : ''} />
              <datalist id="customerlist">
                ${customers.map((c) => `<option value="${esc(c.name)}"></option>`).join('')}
              </datalist>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div class="field" style="margin-bottom:0">
                <label for="quotedate">Date</label>
                <input type="date" id="quotedate" value="${esc(model.quoteDate || '')}" ${readOnly() ? 'disabled' : ''} />
              </div>
              <div class="field" style="margin-bottom:0">
                <label for="valid">Valid until</label>
                <input type="date" id="valid" value="${esc(model.validUntil || '')}" ${readOnly() ? 'disabled' : ''} />
              </div>
            </div>
            <div class="faint" id="validity-note" style="font-size:11.5px;margin-top:7px"></div>`))}

          <div style="height:14px"></div>
          <div id="creditcard"></div>
          <div style="height:14px"></div>

          ${raw(card('Totals', `<div class="totals">
            <div class="row"><span class="dim">Subtotal</span><span id="t-subtotal">${rupees2(t.subtotal)}</span></div>
            <div class="row"><span class="dim">GST</span><span id="t-gst">${rupees2(t.tax)}</span></div>
            <div class="row grand"><span>Total</span><span id="t-total">${rupees2(t.subtotal + t.tax)}</span></div>
          </div>`))}

          ${raw(model.versions.length > 1 ? `<div style="height:14px"></div>${card('Revisions',
            `<div class="totals">${model.versions.map((v) => `<div class="row">
               <span class="${v.id === model.id ? '' : 'dim'}">rev ${v.version} <span class="faint">${v.status}</span></span>
               <span>${money(v.total)}</span></div>`).join('')}</div>`)}` : '')}
        </div>
      </div>
    `;

    drawCredit();
    drawLines();
    drawActions();
    wire();
    drawValidityNote();
  }

  /** Says in words how long the quote stands, and flags one already expired. */
  function drawValidityNote() {
    const note = el.querySelector('#validity-note');
    if (!note) return;
    if (!model.quoteDate || !model.validUntil) {
      note.textContent = '';
      return;
    }
    const days = Math.round(
      (Date.parse(`${model.validUntil}T00:00:00`) - Date.parse(`${model.quoteDate}T00:00:00`)) / 86400000
    );
    // An expiry that is not the derived one was set by hand — no need to
    // remember that separately.
    const custom = model.validUntil !== addDaysISO(model.quoteDate, validityDays);
    const lapsed = model.validUntil < todayISO();
    note.innerHTML = lapsed
      ? `<span class="pill bad">Expired</span> validity ran out on ${shortDate(model.validUntil)}`
      : `Stands for ${days} day${days === 1 ? '' : 's'}${custom ? ' (set by hand — changing the date resets it)' : ''}.`;
  }

  function drawCredit() {
    const holder = el.querySelector('#creditcard');
    if (!credit) {
      holder.innerHTML = card('Credit position', '<div class="faint" style="font-size:12.5px">Pick a customer to see their outstanding and limit.</div>');
      return;
    }
    const tone = credit.overLimit ? 'bad' : credit.overdue > 0 ? 'warn' : 'ok';
    const label = credit.overLimit ? 'Over limit' : credit.overdue > 0 ? 'Has overdue bills' : 'Within terms';
    holder.innerHTML = card('Credit position', `
      <div class="credit-panel">
        <div class="row"><span class="dim">Outstanding</span><span>${money(credit.outstanding)}</span></div>
        <div class="row"><span class="dim">Overdue</span><span class="${credit.overdue ? 'bad' : 'faint'}">${credit.overdue ? money(credit.overdue) : '—'}</span></div>
        <div class="row"><span class="dim">Credit limit</span><span>${credit.creditLimit ? money(credit.creditLimit) : 'none set'}</span></div>
        <div class="row"><span class="dim">Payment terms</span><span>${credit.creditPeriodDays} days</span></div>
        <div class="row"><span class="dim">Open bills</span><span>${credit.openBills}</span></div>
        <div class="row" style="border-top:1px solid var(--border);padding-top:7px;margin-top:2px">
          <span class="dim">With this quote</span><span id="c-after">—</span>
        </div>
        <div id="c-after-flag"></div>
        <div style="margin-top:4px"><span class="pill ${tone}">${label}</span></div>
      </div>`, { note: 'from Tally' });
    recalcCreditProjection(lineTotals().subtotal + lineTotals().tax);
  }

  function drawLines() {
    const body = el.querySelector('#lines');
    if (!model.lines.length) {
      body.innerHTML = `<tr><td colspan="9" class="empty">No items yet.${readOnly() ? '' : ' Search above to add them.'}</td></tr>`;
      return;
    }
    body.innerHTML = model.lines
      .map((l, i) => {
        const ro = readOnly() ? 'disabled' : '';
        return `<tr>
          <td class="faint">${i + 1}</td>
          <td>
            <div class="truncate" title="${esc(l.itemName)}">${esc(l.itemName)}</div>
            <div class="faint mono" style="font-size:11px">${esc(l.itemCode || '')}${esc(l.brand ? ` · ${l.brand}` : '')}<span data-listnote="${i}">${listNote(l)}</span></div>
          </td>
          <td><input data-i="${i}" data-k="qty" value="${l.qty}" ${ro} /></td>
          <td><input class="text" data-i="${i}" data-k="units" value="${esc(l.units || '')}" ${ro} /></td>
          <td><input data-i="${i}" data-k="rate" value="${l.rate}" ${ro} /></td>
          <td><input data-i="${i}" data-k="discountPct" value="${l.discountPct || 0}" ${ro} /></td>
          <td><input data-i="${i}" data-k="gstRate" value="${l.gstRate || 0}" ${ro} /></td>
          <td class="num" data-amount="${i}">${rupees2(taxableOf(l))}</td>
          <td>${readOnly() ? '' : `<button class="del" data-del="${i}" title="Remove">×</button>`}</td>
        </tr>`;
      })
      .join('');
  }

  function drawActions() {
    const bar = el.querySelector('#actions');
    const buttons = [];
    if (!readOnly()) {
      buttons.push('<button class="btn primary small" id="save">Save draft</button>');
      if (model.id) buttons.push('<button class="btn small" id="send">Mark sent</button>');
    } else {
      buttons.push('<button class="btn small" id="revise">Revise</button>');
      if (model.status === 'sent') {
        buttons.push('<button class="btn small" id="won">Accepted</button>');
        buttons.push('<button class="btn small" id="lost">Lost…</button>');
      }
    }
    if (model.id) {
      buttons.push('<button class="btn small" id="copy">Copy for email</button>');
      buttons.push('<button class="btn small" id="copytext">Copy plain text</button>');
    }
    bar.innerHTML = buttons.join('');
  }

  /**
   * Navigate to a quotation. Setting the hash re-renders through the router,
   * but saving a quotation that is already open leaves the hash unchanged and
   * therefore fires nothing — so that case has to re-render itself.
   */
  function goTo(quotationId) {
    const target = `#/quotations?id=${quotationId}`;
    if (location.hash === target) render(el);
    else location.hash = target;
  }

  // --- interactions --------------------------------------------------------
  function wire() {
    el.querySelector('#back').addEventListener('click', () => { location.hash = '#/quotations'; });

    const customerInput = el.querySelector('#customer');
    customerInput?.addEventListener('change', async () => {
      model.customerName = customerInput.value.trim();
      await loadCredit();
      drawCredit();
    });
    const validInput = el.querySelector('#valid');
    el.querySelector('#quotedate')?.addEventListener('change', (e) => {
      model.quoteDate = e.target.value;
      // Moving the date always resets the expiry, even if it had been set by
      // hand earlier: whichever of the two was touched last is the decision
      // that stands.
      if (model.quoteDate) {
        model.validUntil = addDaysISO(model.quoteDate, validityDays);
        if (validInput) validInput.value = model.validUntil;
      }
      drawValidityNote();
    });
    validInput?.addEventListener('change', (e) => {
      model.validUntil = e.target.value;
      drawValidityNote();
    });
    el.querySelector('#notes')?.addEventListener('input', (e) => { model.notes = e.target.value; });

    // Recalculate on every keystroke. Deliberately does NOT redraw the row —
    // rebuilding the table under the cursor would drop focus and the caret
    // position mid-number. Only the figures that changed are rewritten.
    el.querySelectorAll('.lines input[data-k]').forEach((input) => {
      const apply = () => {
        const i = Number(input.dataset.i);
        const k = input.dataset.k;
        model.lines[i][k] = k === 'units' ? input.value : Number(input.value) || 0;
        recalcLine(i);
        recalcTotals();
      };
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
    });
    el.querySelectorAll('[data-del]').forEach((btn) =>
      btn.addEventListener('click', () => {
        model.lines.splice(Number(btn.dataset.del), 1);
        draw();
      })
    );

    wireSearch();
    wireActions();
  }

  /** "· list ₹640.00" — shown only while the quoted rate is under list. */
  function listNote(l) {
    return l.listRate && n(l.rate) && n(l.rate) < l.listRate
      ? ` · list ${rupees2(l.listRate)}`
      : '';
  }

  function recalcLine(i) {
    const line = model.lines[i];
    const amount = el.querySelector(`[data-amount="${i}"]`);
    if (amount) amount.textContent = rupees2(taxableOf(line));
    const note = el.querySelector(`[data-listnote="${i}"]`);
    if (note) note.textContent = listNote(line);
  }

  function recalcTotals() {
    const t = lineTotals();
    const set = (id, value) => {
      const node = el.querySelector(id);
      if (node) node.textContent = rupees2(value);
    };
    set('#t-subtotal', t.subtotal);
    set('#t-gst', t.tax);
    set('#t-total', t.subtotal + t.tax);
    recalcCreditProjection(t.subtotal + t.tax);
  }

  /**
   * What this quote would do to the customer's exposure. Credit is reported
   * rather than enforced, so the least it can do is answer the question live
   * while the quote is still being priced.
   */
  function recalcCreditProjection(quoteTotal) {
    if (!credit) return;
    const after = credit.outstanding + quoteTotal;
    const over = credit.creditLimit > 0 && after > credit.creditLimit;

    const value = el.querySelector('#c-after');
    if (value) {
      value.textContent = money(after);
      value.className = over ? 'bad' : '';
    }
    const flag = el.querySelector('#c-after-flag');
    if (flag) {
      flag.innerHTML = over
        ? `<span class="pill bad">This quote takes them ${money(after - credit.creditLimit)} past their limit</span>`
        : '';
    }
  }

  function wireSearch() {
    const input = el.querySelector('#itemsearch');
    if (!input) return;
    const results = el.querySelector('#results');
    let timer;
    let current = [];

    const close = () => { results.innerHTML = ''; };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const term = input.value.trim();
      if (term.length < 2) return close();
      timer = setTimeout(async () => {
        const params = new URLSearchParams({ search: term, limit: '12' });
        if (model.customerName) params.set('customer', model.customerName);
        const { rows } = await api(`/catalogue?${params}`);
        current = rows;
        results.innerHTML = rows.length
          ? `<div class="results">${rows
              .map((r, i) => {
                const stock = r.match_method === 'unmatched'
                  ? '<span class="pill">not stocked</span>'
                  : `<span class="${r.closing_qty > 0 ? 'dim' : 'bad'}">${qty(r.closing_qty)} ${esc(r.base_units || '')} in stock</span>`;
                const last = r.last_rate
                  ? `<div class="last">last ${rupees2(r.last_rate)} · ${shortDate(r.last_rate_date)}</div>`
                  : model.customerName
                  ? '<div class="last faint">not sold before</div>'
                  : '';
                return `<div class="result" data-i="${i}">
                  <div>
                    <div class="title">${esc(r.name)}</div>
                    <div class="meta"><span class="mono">${esc(r.code)}</span><span>${esc(r.brand)}</span>${stock}</div>
                  </div>
                  <div class="rates"><div class="list">${rupees2(r.list_rate)}</div>${last}</div>
                </div>`;
              })
              .join('')}</div>`
          : `<div class="results"><div class="empty">Nothing matches “${esc(term)}”.</div></div>`;

        results.querySelectorAll('.result').forEach((node) =>
          node.addEventListener('click', () => {
            const r = current[Number(node.dataset.i)];
            model.lines.push({
              itemName: r.name, itemCode: r.code, itemGuid: r.tally_guid, brand: r.brand,
              hsn: r.hsn, qty: 1, units: r.units || 'Nos', listRate: r.list_rate,
              // Default to what this customer last actually paid, not list.
              rate: r.last_rate ?? r.list_rate,
              discountPct: 0, gstRate: r.gst_rate ?? 18, remarks: '',
            });
            input.value = '';
            close();
            draw();
            el.querySelector('#itemsearch')?.focus();
          })
        );
      }, 180);
    });

    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.addEventListener('click', (e) => {
      if (!results.contains(e.target) && e.target !== input) close();
    });
  }

  function wireActions() {
    const body = () => ({
      customerName: model.customerName,
      lines: model.lines,
      notes: model.notes,
      quoteDate: model.quoteDate || null,
      validUntil: model.validUntil || null,
    });

    el.querySelector('#save')?.addEventListener('click', async (e) => {
      if (!model.customerName) return alert('Pick a customer first.');
      e.target.disabled = true;
      try {
        const saved = model.id
          ? await api(`/quotations/${model.id}`, { method: 'PUT', body: JSON.stringify(body()) })
          : await api('/quotations', { method: 'POST', body: JSON.stringify(body()) });
        goTo(saved.id);
      } catch (err) {
        alert(err.message);
        e.target.disabled = false;
      }
    });

    el.querySelector('#send')?.addEventListener('click', async () => {
      await api(`/quotations/${model.id}`, { method: 'PUT', body: JSON.stringify(body()) });
      await api(`/quotations/${model.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'sent' }) });
      render(el);
    });
    el.querySelector('#revise')?.addEventListener('click', async () => {
      const rev = await api(`/quotations/${model.id}/revise`, { method: 'POST' });
      goTo(rev.id);
    });
    el.querySelector('#won')?.addEventListener('click', async () => {
      await api(`/quotations/${model.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'accepted' }) });
      render(el);
    });
    el.querySelector('#lost')?.addEventListener('click', async () => {
      const reason = prompt('Why was it lost? (price / stock / delivery / no-response / other)');
      if (reason === null) return;
      await api(`/quotations/${model.id}/status`, {
        method: 'POST', body: JSON.stringify({ status: 'lost', lostReason: reason }),
      });
      render(el);
    });

    const copy = async (which, btn) => {
      const full = await api(`/quotations/${model.id}`);
      const label = btn.textContent;
      try {
        if (which === 'html' && window.ClipboardItem) {
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/html': new Blob([full.html], { type: 'text/html' }),
              'text/plain': new Blob([full.text], { type: 'text/plain' }),
            }),
          ]);
        } else {
          await navigator.clipboard.writeText(which === 'html' ? full.html : full.text);
        }
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Copy failed';
      }
      setTimeout(() => { btn.textContent = label; }, 1600);
    };
    el.querySelector('#copy')?.addEventListener('click', (e) => copy('html', e.target));
    el.querySelector('#copytext')?.addEventListener('click', (e) => copy('text', e.target));
  }

  draw();
}
