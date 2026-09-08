import { api, html, raw, card, kpi, count, dateTime, shortDate, esc, emptyState } from '../util.js';

export const title = 'Mail';

const KIND_TONE = { order: 'ok', inquiry: 'accent', unclassified: 'warn', ignored: '' };
const KIND_LABEL = {
  order: 'Order',
  inquiry: 'Enquiry',
  unclassified: 'Not classified',
  ignored: 'Set aside',
};

export async function render(el) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const id = params.get('id');
  return id ? detail(el, Number(id)) : list(el);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
async function list(el) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const initialKind = params.get('kind') || '';
  const { threads, summary } = await api(`/mail?${new URLSearchParams({ kind: initialKind })}`);

  el.innerHTML = html`
    <div class="grid cols-4" style="margin-bottom:14px">
      ${raw(kpi({
        label: 'Waiting on you',
        value: count(summary.needsReview),
        tone: summary.needsReview ? 'warn' : '',
        sub: 'no number raised, or no ledger behind the sender',
      }))}
      ${raw(kpi({ label: 'Orders raised', value: count(summary.byKind.order || 0), sub: 'mails that became an SO' }))}
      ${raw(kpi({ label: 'Enquiries raised', value: count(summary.byKind.inquiry || 0), sub: 'mails that became a quotation' }))}
      ${raw(kpi({
        label: 'Sender unmatched',
        value: count(summary.unmatchedParty),
        tone: summary.unmatchedParty ? 'bad' : '',
        sub: 'not tied to a Tally ledger',
      }))}
    </div>

    <div class="toolbar">
      <input type="search" id="q" placeholder="Subject, customer, or their reference…" />
      <select id="kind">
        <option value="">Every thread</option>
        <option value="review">Waiting on you</option>
        <option value="order">Orders</option>
        <option value="inquiry">Enquiries</option>
        <option value="unclassified">Not classified</option>
        <option value="unmatched_party">Sender unmatched</option>
        <option value="ignored">Set aside</option>
      </select>
      <span class="dim" id="tally-note"></span>
    </div>

    <div id="holder"></div>
  `;
  el.querySelector('#kind').value = initialKind;
  el.querySelector('#tally-note').textContent = summary.lastMessageAt
    ? `${count(summary.messages)} mails across ${count(summary.threads)} threads · latest ${dateTime(summary.lastMessageAt)}`
    : 'Nothing pushed in yet.';

  const draw = (rows) => {
    el.querySelector('#holder').innerHTML = card(
      'Mail threads',
      rows.length
        ? `<div class="table-wrap"><table>
            <thead><tr>
              <th>Subject</th><th>Customer</th><th>Their ref</th><th>Record</th>
              <th class="num">Mails</th><th>Latest</th><th>Status</th>
            </tr></thead>
            <tbody>${rows.map(rowHtml).join('')}</tbody></table></div>`
        : emptyState('No mail threads yet. The Apps Script pushes them in — see docs/gmail-mail-ingest.md.'),
      { flush: true }
    );
    el.querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.addEventListener('click', () => { location.hash = `#/mail?id=${tr.dataset.id}`; })
    );
  };
  draw(threads);

  let timer;
  const refresh = async () => {
    const r = await api(`/mail?${new URLSearchParams({
      search: el.querySelector('#q').value,
      kind: el.querySelector('#kind').value,
    })}`);
    draw(r.threads);
  };
  el.querySelector('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(refresh, 200); });
  el.querySelector('#kind').addEventListener('change', refresh);
}

const rowHtml = (t) => `<tr data-id="${t.id}" style="cursor:pointer">
  <td class="truncate" style="max-width:340px">${esc(t.subject)}</td>
  <td class="truncate ${t.customer_guid ? '' : 'warn'}" style="max-width:200px">${esc(t.customer_name || '—')}</td>
  <td class="mono faint nowrap">${esc(t.customer_ref_raw || '—')}</td>
  <td class="mono nowrap">${
    [t.quote_number, t.order_number].filter(Boolean).map(esc).join(' <span class="dim">→</span> ') || '—'
  }</td>
  <td class="num dim">${t.message_count}</td>
  <td class="dim nowrap">${shortDate(t.last_message_at)}</td>
  <td><span class="pill ${KIND_TONE[t.kind] || ''}">${KIND_LABEL[t.kind] || t.kind}</span>${
    t.needs_review ? ' <span class="pill warn">needs you</span>' : ''
  }</td>
</tr>`;

// ---------------------------------------------------------------------------
// One thread
// ---------------------------------------------------------------------------
async function detail(el, id) {
  const t = await api(`/mail/${id}`);
  const backLink = '<a class="btn small" href="#/mail">← All mail</a>';

  el.innerHTML = html`
    <div class="toolbar">
      ${raw(backLink)}
      <span class="pill ${raw(KIND_TONE[t.kind] || '')}">${KIND_LABEL[t.kind] || t.kind}</span>
      ${raw(t.needs_review ? '<span class="pill warn">needs you</span>' : '')}
    </div>
    <div id="head"></div>
    <div id="actions"></div>
    <div id="messages"></div>
  `;

  el.querySelector('#head').innerHTML = card(
    t.subject,
    `<div class="quote-grid">
      ${field('Customer', t.customer_guid
        ? esc(t.customer_name)
        : `<span class="warn">${esc(t.customer_name || 'Unknown')}</span> <span class="dim">— no Tally ledger</span>`)}
      ${field('Their reference', t.customer_ref_raw ? `<span class="mono">${esc(t.customer_ref_raw)}</span>` : '<span class="dim">none in the subject</span>')}
      ${field('Record raised', recordLink(t))}
      ${field('Decided by', t.decided_by ? `${esc(t.decided_by)} <span class="dim">${t.decided_at ? dateTime(t.decided_at) : ''}</span>` : '<span class="dim">not yet</span>')}
      ${field('Mails', `${t.message_count} · first ${shortDate(t.first_message_at)}, latest ${shortDate(t.last_message_at)}`)}
      ${field('Threading key', `<span class="mono faint">${esc(t.party_key)}</span>`)}
    </div>
    ${t.review_reason ? `<div class="callout warn" style="margin-top:12px">${esc(t.review_reason)}</div>` : ''}`
  );

  await drawActions(el, t);
  drawMessages(el, t);
}

const field = (label, value) => `<div class="field"><label>${esc(label)}</label><div>${value}</div></div>`;

/**
 * Both, when there are both. An enquiry that became a purchase order is the
 * ordinary case, and showing only the order would hide the quotation that the
 * order was agreed against — which is the one thing the threading was for.
 */
function recordLink(t) {
  const parts = [];
  if (t.quote_number) {
    parts.push(`<a class="mono" href="#/quotations?id=${t.quotation_id}">${esc(t.quote_number)}</a>` +
      ` <span class="dim">v${t.quote_version} · ${esc(t.quote_status || '')}</span>`);
  }
  if (t.order_number) {
    parts.push(`<a class="mono" href="#/orders?id=${t.order_id}">${esc(t.order_number)}</a>` +
      ` <span class="dim">${esc(t.order_status || '')}</span>`);
  }
  if (!parts.length) return '<span class="dim">none — nothing has been raised from this thread</span>';
  return parts.join('<span class="dim"> → </span>');
}

async function drawActions(el, t) {
  const holder = el.querySelector('#actions');
  const needsKind = t.kind === 'unclassified';
  const needsParty = !t.customer_guid && t.kind !== 'ignored';
  if (!needsKind && !needsParty) { holder.innerHTML = ''; return; }

  holder.innerHTML = card(
    'Waiting on you',
    `${needsKind ? `
      <p class="dim" style="margin:0 0 10px">
        Nothing was raised from this thread because the rules could not tell what it is.
        Saying which mints the number and files it — an order takes a BE/SO number, an enquiry a BE/Q number.
      </p>
      <div class="toolbar" style="margin:0 0 ${needsParty ? '16px' : '0'}">
        <button class="btn primary" data-kind="order">This is an order</button>
        <button class="btn" data-kind="inquiry">This is an enquiry</button>
        <button class="btn" data-kind="ignored">Neither — set aside</button>
      </div>` : ''}
    ${needsParty ? `
      <p class="dim" style="margin:0 0 10px">
        <strong>${esc(t.customer_name || 'This sender')}</strong> is not tied to a Tally ledger.
        Bind them once and every mail from them afterwards is matched without being asked.
      </p>
      <div class="toolbar" style="margin:0">
        <input list="mail-customers" id="bind-customer" placeholder="Tally customer…" style="min-width:260px" />
        <datalist id="mail-customers"></datalist>
        <select id="bind-scope"></select>
        <button class="btn primary" id="bind">Bind sender</button>
      </div>` : ''}
    <div id="action-error"></div>`
  );

  const fail = (msg) => {
    holder.querySelector('#action-error').innerHTML = `<div class="callout warn" style="margin-top:12px">${esc(msg)}</div>`;
  };

  holder.querySelectorAll('button[data-kind]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/mail/${t.id}/classify`, { method: 'POST', body: JSON.stringify({ kind: b.dataset.kind }) });
        await detail(el, t.id);
      } catch (err) { fail(err.message); b.disabled = false; }
    })
  );

  if (!needsParty) return;

  // The sender's own address, and their domain when it is a company domain.
  // A free-mail domain is never offered: binding gmail.com would file every
  // unrelated person on Gmail as one customer.
  const sender = (t.messages.find((m) => m.direction === 'in') || t.messages[0] || {}).from_email || '';
  const domain = sender.split('@')[1] || '';
  const free = t.party_key.startsWith('email:');
  holder.querySelector('#bind-scope').innerHTML =
    `<option value="address">just ${esc(sender)}</option>` +
    (domain && !free ? `<option value="domain" selected>everyone @${esc(domain)}</option>` : '');

  const { customers } = await api('/customers');
  holder.querySelector('#mail-customers').innerHTML = customers.map((c) => `<option value="${esc(c.name)}"></option>`).join('');

  holder.querySelector('#bind').addEventListener('click', async () => {
    const btn = holder.querySelector('#bind');
    btn.disabled = true;
    try {
      const scope = holder.querySelector('#bind-scope').value;
      await api('/mail/party', {
        method: 'POST',
        body: JSON.stringify({
          scope,
          value: scope === 'domain' ? domain : sender,
          customerName: holder.querySelector('#bind-customer').value,
        }),
      });
      await detail(el, t.id);
    } catch (err) { fail(err.message); btn.disabled = false; }
  });
}

function drawMessages(el, t) {
  el.querySelector('#messages').innerHTML = card(
    `${t.messages.length} mail${t.messages.length === 1 ? '' : 's'} in this thread`,
    t.messages.map(messageHtml).join('') || emptyState('No messages.'),
    { note: 'oldest first' }
  );
}

function messageHtml(m) {
  const named = m.from_name && m.from_name !== m.from_email;
  const who = m.direction === 'out'
    ? `<span class="pill">sent</span> to ${esc(m.to_emails || '—')}`
    : named
    ? `${esc(m.from_name)} <span class="faint mono">${esc(m.from_email || '')}</span>`
    : `<span class="mono">${esc(m.from_email || 'Unknown')}</span>`;

  const verdict = m.direction === 'out'
    ? ''
    : `<span class="pill ${KIND_TONE[m.classified_as] || ''}">${KIND_LABEL[m.classified_as] || m.classified_as}</span>
       <span class="dim">order ${m.order_score} · enquiry ${m.inquiry_score}${m.classify_reason ? ` — ${esc(m.classify_reason)}` : ''}</span>`;

  const files = (m.attachments || []).map((a) =>
    a.url
      ? `<a class="pill" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.name)}</a>`
      : `<span class="pill" title="not saved to Drive">${esc(a.name)}</span>`
  ).join(' ');

  return `<div class="ageing-row" style="display:block;padding:12px 0">
    <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
      <strong>${who}</strong>
      <span class="spacer" style="flex:1"></span>
      <span class="dim nowrap">${dateTime(m.sent_at)}</span>
      ${m.permalink ? `<a class="btn small" href="${esc(m.permalink)}" target="_blank" rel="noopener noreferrer">Open in Gmail</a>` : ''}
    </div>
    <div class="dim" style="margin:4px 0">${esc(m.subject || '')}</div>
    <div style="margin:6px 0">${verdict}</div>
    ${files ? `<div style="margin:6px 0">${files}</div>` : ''}
    ${m.body_text ? `<details style="margin-top:6px"><summary class="dim">Read the mail</summary>
      <pre style="white-space:pre-wrap;margin:8px 0 0;font:inherit">${esc(m.body_text.slice(0, 4000))}</pre></details>` : ''}
  </div>`;
}
