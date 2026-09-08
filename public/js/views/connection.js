import { api, html, raw, card, esc, count, dateTime, ago, emptyState } from '../util.js';

export const title = 'Connection';

export async function render(el) {
  const [target, status, probes, connections] = await Promise.all([
    api('/tally/target'),
    api('/sync/status'),
    api('/tally/probes'),
    api('/connections'),
  ]);

  el.innerHTML = html`
    <div id="store"></div>
    <div id="gmail"></div>

    ${raw(
      target.simulated
        ? `<div class="callout warn" style="margin-bottom:14px">
             <strong>Running against a simulated TallyPrime.</strong>
             The fake Tally is a real HTTP server speaking the real XML protocol on port ${target.port}, so every
             request and parser below is the one that will run against the office machine.
             To cut over: set <code>TALLY_MODE=live</code> and <code>TALLY_HOST</code> in <code>.env</code>, then
             restart. Nothing else changes.
           </div>`
        : `<div class="callout" style="margin-bottom:14px">
             <strong>Connected to the live TallyPrime</strong> at ${esc(target.url)}.
           </div>`
    )}

    <div class="grid cols-2" style="margin-bottom:14px">
      ${raw(card(
        'Tally connection',
        html`<table>
            <tbody>
              <tr><td class="dim">Mode</td><td><span class="pill ${raw(target.simulated ? 'warn' : 'ok')}">${target.mode}</span></td></tr>
              <tr><td class="dim">Endpoint</td><td class="mono">${target.url}</td></tr>
              <tr><td class="dim">Company</td><td>${target.company}</td></tr>
              <tr><td class="dim">Sync interval</td><td>every ${target.syncIntervalMinutes} minutes</td></tr>
            </tbody>
          </table>
          <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
            <button class="btn primary small" id="ping">Test connection</button>
            <span id="ping-result" class="dim"></span>
          </div>`
      ))}

      ${raw(card(
        'Last sync',
        status.last
          ? html`<table><tbody>
              <tr><td class="dim">Status</td><td><span class="pill ${raw(
                status.last.status === 'ok' ? 'ok' : status.last.status === 'partial' ? 'warn' : 'bad'
              )}">${status.last.status}</span></td></tr>
              <tr><td class="dim">Finished</td><td>${dateTime(status.last.finished_at)} <span class="faint">(${raw(ago(status.last.finished_at))})</span></td></tr>
              <tr><td class="dim">Triggered by</td><td>${status.last.trigger}</td></tr>
              <tr><td class="dim">Took</td><td>${count(status.last.duration_ms)} ms</td></tr>
              ${raw(status.last.error ? `<tr><td class="dim">Error</td><td class="bad">${esc(status.last.error)}</td></tr>` : '')}
            </tbody></table>
            <div style="margin-top:12px">
              <table><thead><tr><th>Dataset</th><th class="num">Records</th><th class="num">Time</th><th></th></tr></thead>
              <tbody>${raw(
                status.last.datasets
                  .map(
                    (ds) => `<tr>
                      <td>${esc(ds.dataset)}</td>
                      <td class="num">${count(ds.records)}</td>
                      <td class="num dim">${count(ds.duration_ms)} ms</td>
                      <td>${ds.status === 'ok' ? '<span class="pill ok">ok</span>' : `<span class="pill bad" title="${esc(ds.message || '')}">failed</span>`}</td>
                    </tr>`
                  )
                  .join('')
              )}</tbody></table>
            </div>`
          : emptyState('No sync has run yet.'),
        { flush: false }
      ))}
    </div>

    ${raw(card(
      'XML console',
      html`<p class="dim" style="margin:0 0 12px;font-size:12.5px">
          Send one of the app's own requests and read the raw reply. This is the fastest way to find out
          <em>why</em> a dataset is wrong once the real Tally is connected — the request shown here is byte-for-byte
          what the sync sends.
        </p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="probe">
            ${raw(probes.probes.map((p) => `<option value="${p.key}">${esc(p.label)}</option>`).join(''))}
          </select>
          <button class="btn small" id="run-probe">Send request</button>
          <span id="probe-meta" class="faint"></span>
        </div>
        <div class="grid cols-2" style="margin-top:14px">
          <div><div class="faint" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Request</div>
            <pre class="xml" id="probe-req">—</pre></div>
          <div><div class="faint" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Response</div>
            <pre class="xml" id="probe-res">—</pre></div>
        </div>`
    ))}

    <div style="height:14px"></div>

    ${raw(card(
      'Sync history',
      status.history.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>Started</th><th>Trigger</th><th>Mode</th><th class="num">Took</th><th class="num">Records</th><th></th></tr></thead>
            <tbody>${status.history
              .map((r) => {
                const records = r.datasets.reduce((s, d) => s + d.records, 0);
                return `<tr>
                  <td class="nowrap">${dateTime(r.started_at)}</td>
                  <td class="dim">${r.trigger}</td>
                  <td class="dim">${r.mode}</td>
                  <td class="num dim">${r.duration_ms ? `${count(r.duration_ms)} ms` : '—'}</td>
                  <td class="num">${count(records)}</td>
                  <td><span class="pill ${r.status === 'ok' ? 'ok' : r.status === 'partial' ? 'warn' : r.status === 'running' ? '' : 'bad'}">${r.status}</span></td>
                </tr>`;
              })
              .join('')}</tbody></table></div>`
        : emptyState('Nothing yet.'),
      { flush: true }
    ))}
  `;

  storeSection(el, connections.store);
  mailSection(el, connections.mail);

  const pingBtn = el.querySelector('#ping');
  const pingResult = el.querySelector('#ping-result');
  pingBtn.addEventListener('click', async () => {
    pingBtn.disabled = true;
    pingResult.textContent = 'Testing…';
    try {
      const r = await api('/tally/ping');
      pingResult.innerHTML = `<span class="pill ${r.ok && r.companyFound ? 'ok' : r.ok ? 'warn' : 'bad'}">${
        r.ok && r.companyFound ? 'PASS' : r.ok ? 'CHECK' : 'FAIL'
      }</span> ${esc(r.message)} <span class="faint">(${r.elapsedMs} ms)</span>`;
    } catch (e) {
      pingResult.innerHTML = `<span class="pill bad">FAIL</span> ${esc(e.message)}`;
    }
    pingBtn.disabled = false;
  });

  const probeBtn = el.querySelector('#run-probe');
  probeBtn.addEventListener('click', async () => {
    probeBtn.disabled = true;
    el.querySelector('#probe-meta').textContent = 'sending…';
    try {
      const r = await api('/tally/probe', {
        method: 'POST',
        body: JSON.stringify({ probe: el.querySelector('#probe').value }),
      });
      el.querySelector('#probe-req').textContent = r.request;
      el.querySelector('#probe-res').textContent = r.ok ? r.response : r.error;
      el.querySelector('#probe-meta').innerHTML = r.ok
        ? `<span class="pill ok">${r.elapsedMs} ms · ${count(r.bytes)} bytes</span>`
        : `<span class="pill bad">failed</span>`;
    } catch (e) {
      el.querySelector('#probe-res').textContent = e.message;
      el.querySelector('#probe-meta').innerHTML = '<span class="pill bad">failed</span>';
    }
    probeBtn.disabled = false;
  });
}

// ---------------------------------------------------------------------------
// Gmail and the sheet
// ---------------------------------------------------------------------------

/**
 * The mail side of the connection screen.
 *
 * It reads differently from the two cards above, and it should: there is no
 * "test connection" button here because there is nothing to test. This is the
 * one direction that still pushes IN — the sweep posts each mail to the ERP,
 * and nothing here reaches out to Gmail. So the honest question is not "can we
 * reach Google" but "has anything arrived lately", and that is what this shows.
 */
function mailSection(el, mail) {
  const live = mail.ingestConfigured;
  const quiet = mail.lastIngestAt
    ? `last push ${ago(mail.lastIngestAt)}`
    : 'nothing has ever been pushed in';

  el.querySelector('#gmail').innerHTML = card(
    'Gmail sweep',
    html`
      ${raw(live
        ? `<div class="callout" style="margin-bottom:12px">
             <strong>Ingest is open.</strong> The Apps Script in your sales@ account posts each mail to
             <code>/api/ingest/mail</code>; ${esc(quiet)}.
           </div>`
        : `<div class="callout warn" style="margin-bottom:12px">
             <strong>Ingest is off.</strong> No <code>INGEST_TOKEN</code> is set on this server, so the endpoint
             fails closed and the sweep cannot post anything at all. This is the usual reason for
             &ldquo;nothing is arriving&rdquo;.
           </div>`)}

      <table>
        <tbody>
          <tr><td class="dim">Direction</td><td>Apps Script &rarr; this ERP. Nothing here reads your mailbox. (The sheet is read by the store above, the other way round.)</td></tr>
          <tr><td class="dim">Token</td><td>${raw(live
            ? '<span class="pill ok">set</span>'
            : '<span class="pill bad">not set</span>')}</td></tr>
          <tr><td class="dim">Our own mail</td><td class="mono">${raw(
            [...mail.ownDomains.map((d) => `@${esc(d)}`), ...mail.ownAddresses.map(esc)].join(', ') || '<span class="dim">not configured</span>'
          )}</td></tr>
          <tr><td class="dim">Logged so far</td><td>${count(mail.messages)} mails across ${count(mail.threads)} threads${raw(
            mail.needsReview ? ` &middot; <a href="#/mail?kind=review">${count(mail.needsReview)} waiting on you</a>` : ''
          )}</td></tr>
          <tr><td class="dim">Latest mail</td><td>${raw(mail.lastMessageAt ? dateTime(mail.lastMessageAt) : '<span class="dim">none yet</span>')}</td></tr>
        </tbody>
      </table>

      <div style="margin-top:16px">
        <label class="dim" for="sheet-url">Google Sheet the sweep writes to</label>
        <div class="toolbar" style="margin:6px 0 0">
          <input id="sheet-url" style="min-width:420px" placeholder="Paste the sheet link, or its id"
                 value="${esc(mail.sheetUrl || '')}" />
          <button class="btn primary" id="save-sheet">Save</button>
          ${raw(mail.sheetUrl
            ? `<a class="btn small" href="${esc(mail.sheetUrl)}" target="_blank" rel="noopener noreferrer">Open sheet</a>`
            : '')}
        </div>
        <p class="dim" style="margin:8px 0 0">
          The same spreadsheet the store above reads and writes. Recorded here so it can be checked against the
          Apps Script's <code>ERP_SHEET_ID</code>: the sweep writing to one sheet while the ERP reads another is
          the failure that looks exactly like &ldquo;nothing is arriving&rdquo;.
        </p>
        <div id="sheet-result"></div>
      </div>
    `,
    { note: live ? 'open' : 'closed' }
  );

  el.querySelector('#save-sheet').addEventListener('click', async () => {
    const btn = el.querySelector('#save-sheet');
    const out = el.querySelector('#sheet-result');
    btn.disabled = true;
    try {
      const saved = await api('/connections/sheet', {
        method: 'PUT',
        body: JSON.stringify({ url: el.querySelector('#sheet-url').value }),
      });
      out.innerHTML = saved.sheetId
        ? `<div class="callout" style="margin-top:10px">Saved. Sheet id <code>${esc(saved.sheetId)}</code> — it must match <code>ERP_SHEET_ID</code> in the Apps Script.</div>`
        : '<div class="callout" style="margin-top:10px">Cleared.</div>';
      await render(el);
    } catch (err) {
      out.innerHTML = `<div class="callout warn" style="margin-top:10px">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * The Google Sheet, presented as what it is: the store, not a bookmark.
 *
 * This card is the one on the screen with a genuine Test connection button,
 * because unlike the mail sweep there is something to test — the ERP calls
 * out to the sheet, so a failure here is a failure it can see and report.
 *
 * It leads with whether numbering is safe rather than with a green tick. That
 * is the question someone actually has at eight in the morning: can I raise a
 * quotation right now, and if not, why not.
 */
function storeSection(el, store) {
  const readable = store.configured && store.lastPull && store.lastPull.status !== 'failed';

  el.querySelector('#store').innerHTML = card(
    'Store — Google Sheet',
    html`
      ${raw(!store.configured
        ? `<div class="callout warn" style="margin-bottom:12px">
             <strong>No sheet connected.</strong> Everything Tally does not hold — quotations, orders,
             dispatches, invoices — lives only in this machine's <code>data/balaji.db</code>. Connect the
             sheet below and it becomes the store, readable from any machine and survivable if this one is not.
           </div>`
        : store.readyToMint
          ? `<div class="callout" style="margin-bottom:12px">
               <strong>Connected.</strong> The sheet is the record for everything outside Tally;
               this machine holds a copy and pushes every change back.
             </div>`
          : `<div class="callout warn" style="margin-bottom:12px">
               <strong>Connected, but not read yet.</strong> New quotation and order numbers are held back
               until it has been: minting one from a database that has not caught up would issue a number
               that is already on somebody's purchase order. Everything else works normally.
               ${store.lastPullError ? `<br><span class="mono" style="font-size:12px">${esc(store.lastPullError)}</span>` : ''}
             </div>`)}

      <table>
        <tbody>
          <tr><td class="dim">Direction</td><td>This ERP &rarr; Google. Outbound only, which is why it works on localhost with no tunnel.</td></tr>
          <tr><td class="dim">Numbering</td><td>${raw(store.readyToMint
            ? '<span class="pill ok">releasable</span>'
            : '<span class="pill warn">held</span>')}</td></tr>
          <tr><td class="dim">Last read</td><td>${raw(store.lastPull
            ? `${dateTime(store.lastPull.finished_at)} <span class="faint">(${ago(store.lastPull.finished_at)})</span> · ${count(store.lastPull.rows_in)} rows <span class="pill ${store.lastPull.status === 'ok' ? 'ok' : store.lastPull.status === 'partial' ? 'warn' : 'bad'}">${store.lastPull.status}</span>`
            : '<span class="dim">never</span>')}</td></tr>
          <tr><td class="dim">Last write</td><td>${raw(store.lastPush
            ? `${dateTime(store.lastPush.finished_at)} <span class="faint">(${ago(store.lastPush.finished_at)})</span> · ${count(store.lastPush.rows_out)} rows <span class="pill ${store.lastPush.status === 'ok' ? 'ok' : 'bad'}">${store.lastPush.status}</span>`
            : '<span class="dim">never</span>')}</td></tr>
          <tr><td class="dim">Waiting to go out</td><td>${raw(store.pending
            ? `<span class="pill warn">${count(store.pending)}</span> queued since ${dateTime(store.oldestPending)} — normal if the sheet was briefly unreachable`
            : '<span class="pill ok">nothing</span>')}</td></tr>
        </tbody>
      </table>

      ${raw(store.failing?.length
        ? `<div class="callout warn" style="margin-top:12px">
             <strong>Some changes keep failing to go out.</strong>
             <ul style="margin:6px 0 0 18px;padding:0">${store.failing
               .map((f) => `<li class="mono" style="font-size:12px">${esc(f.entity)} #${f.entity_id} — ${f.attempts} attempt(s): ${esc(f.last_error || '')}</li>`)
               .join('')}</ul>
           </div>`
        : '')}

      <div style="margin-top:16px">
        <label class="dim" for="store-url">Apps Script web app URL</label>
        <div style="margin:6px 0 0">
          <input id="store-url" style="width:100%;max-width:640px" placeholder="https://script.google.com/macros/s/…/exec"
                 value="${esc(store.webAppUrl || '')}" />
        </div>
        <label class="dim" for="store-token" style="display:block;margin-top:10px">Token</label>
        <div class="toolbar" style="margin:6px 0 0">
          <input id="store-token" type="password" style="min-width:340px"
                 placeholder="${raw(store.tokenSet ? 'set — leave blank to keep it' : 'from SHEETAPI_setup() in the script')}" />
          <button class="btn" id="store-test">Test connection</button>
          <button class="btn primary" id="store-save">Save</button>
        </div>
        <div id="store-result"></div>
        <p class="dim" style="margin:10px 0 0">
          From the script editor: <em>Deploy → New deployment → Web app</em>, execute as <strong>Me</strong>,
          access <strong>Anyone</strong>. Run <code>SHEETAPI_setup()</code> once for the token. Use the
          <code>/exec</code> URL — <code>/dev</code> only works in a browser you are signed into.
        </p>
      </div>

      <div class="toolbar" style="margin-top:16px">
        <button class="btn small" id="store-pull">Read the sheet now</button>
        <button class="btn small" id="store-push">Send what is queued</button>
        <button class="btn small" id="store-push-all">Replace the sheet from this machine</button>
        <span id="store-op" class="dim"></span>
      </div>
      <p class="dim" style="margin:8px 0 0;font-size:12.5px">
        <strong>Replace</strong> rewrites the ERP's own tabs (${esc(store.ownTabs.map((t) => t.tab).join(', '))})
        from this machine's records. It is for the first connection, and for repair. It never touches
        ${esc(store.scriptTabs.join(', '))} — those belong to the mail sweep, and the script refuses to write them.
      </p>
    `,
    { note: store.configured ? (store.readyToMint ? 'connected' : 'not read') : 'not connected' }
  );

  const out = el.querySelector('#store-result');
  const opNote = el.querySelector('#store-op');
  const urlOf = () => el.querySelector('#store-url').value.trim();
  const tokenOf = () => el.querySelector('#store-token').value.trim();
  const say = (klass, message) => { out.innerHTML = `<div class="callout ${klass}" style="margin-top:10px">${message}</div>`; };

  el.querySelector('#store-test').addEventListener('click', async () => {
    const btn = el.querySelector('#store-test');
    btn.disabled = true;
    out.innerHTML = '<p class="dim" style="margin-top:10px">Testing…</p>';
    try {
      // Tested against what is typed, not what is saved, so a bad paste is
      // caught before it replaces a connection that works.
      const r = await api('/sheets/test', {
        method: 'POST',
        body: JSON.stringify({ webAppUrl: urlOf(), token: tokenOf() }),
      });
      say('', `<strong>Reached “${esc(r.spreadsheetName)}”</strong> in ${r.elapsedMs} ms.
        <br><span class="dim">Tabs: ${esc(r.tabs.map((t) => `${t.name} (${t.rows})`).join(', '))}</span>`);
    } catch (e) {
      say('warn', esc(e.message));
    }
    btn.disabled = false;
  });

  el.querySelector('#store-save').addEventListener('click', async () => {
    const btn = el.querySelector('#store-save');
    btn.disabled = true;
    try {
      await api('/sheets/connection', {
        method: 'PUT',
        body: JSON.stringify({ webAppUrl: urlOf(), token: tokenOf() }),
      });
      await render(el);
    } catch (e) {
      say('warn', esc(e.message));
      btn.disabled = false;
    }
  });

  const runOp = async (id, path, label, confirmWith) => {
    el.querySelector(id).addEventListener('click', async () => {
      if (confirmWith && !window.confirm(confirmWith)) return;
      const btn = el.querySelector(id);
      btn.disabled = true;
      opNote.textContent = `${label}…`;
      try {
        const r = await api(path, { method: 'POST' });
        opNote.innerHTML = `<span class="pill ok">done</span> ${count(r.rows ?? r.pushed ?? 0)} row(s)`;
        await render(el);
      } catch (e) {
        opNote.innerHTML = `<span class="pill bad">failed</span> ${esc(e.message)}`;
        btn.disabled = false;
      }
    });
  };
  runOp('#store-pull', '/sheets/pull', 'Reading');
  runOp('#store-push', '/sheets/push', 'Sending');
  runOp('#store-push-all', '/sheets/push-all', 'Replacing',
    'This replaces the ERP-owned tabs in the sheet with what is on this machine. The mail log is not touched. Continue?');
}
