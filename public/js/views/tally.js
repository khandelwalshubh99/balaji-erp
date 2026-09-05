import { api, html, raw, card, esc, count, dateTime, ago, emptyState } from '../util.js';

export const title = 'Tally connection';

export async function render(el) {
  const [target, status, probes] = await Promise.all([
    api('/tally/target'),
    api('/sync/status'),
    api('/tally/probes'),
  ]);

  el.innerHTML = html`
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
        'Phase 0 — connection check',
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
