import { html, raw, card } from '../util.js';

export const title = 'Roadmap';

const PHASES = [
  {
    n: '0',
    name: 'Prove the connection works',
    state: 'built',
    what: 'Tally answers XML requests from a program we control. Visible on the Tally connection page.',
  },
  {
    n: '1',
    name: 'Read-only visibility layer',
    state: 'built',
    what: 'Stock, receivables ageing and a pending-vs-dispatched snapshot, mirrored from Tally on a timer. Nobody types anything new.',
  },
  {
    n: '2',
    name: 'Shared order-state across departments',
    state: 'next',
    what: 'Quotation → Order Confirmed → Accounts Cleared → Packed → Dispatched → Invoiced, with a screen per department. This is the phase that actually stops dispatch shipping before payment clears.',
  },
  {
    n: '3',
    name: 'Write-back to Tally',
    state: 'later',
    what: 'A cleared order creates its own sales voucher in Tally. Only worth starting once Phase 2 data is trusted — write-back errors cost far more to unwind.',
  },
  {
    n: '4',
    name: 'Guardrails & automation',
    state: 'later',
    what: 'Validated SKU selection, enforced credit limits, and alerts for low stock, overdue receivables and orders stuck too long.',
  },
];

const TONE = { built: 'ok', next: 'accent', later: '' };
const LABEL = { built: 'Built', next: 'Next', later: 'Later' };

export async function render(el) {
  el.innerHTML = html`
    ${raw(card(
      'Where this build stands',
      `<div class="phase-list">${PHASES.map(
        (p) => `<div class="phase">
          <div class="n">${p.n}</div>
          <div><h3>${p.name}</h3><p>${p.what}</p></div>
          <span class="pill ${TONE[p.state]}">${LABEL[p.state]}</span>
        </div>`
      ).join('')}</div>`
    ))}

    <div style="height:14px"></div>

    ${raw(card(
      'Honest limits of what is built today',
      `<ul style="margin:0;padding-left:18px;color:var(--text-dim);font-size:13px;line-height:1.75">
        <li>This is a <strong>mirror of Tally</strong>, refreshed on a timer. It is minutes behind, by design.</li>
        <li>It does not yet change who talks to whom. Phase 1 makes information faster to see; it does not stop
            a dispatch going out before accounts have cleared it.</li>
        <li>Order stages on the Orders screen are <em>inferred</em> from how delivery notes reference sales orders
            in Tally. That inference breaks whenever a reference is typed inconsistently.</li>
        <li>Nothing is written back to Tally. Not until Phase 2 has been running cleanly for a while.</li>
      </ul>`
    ))}

    <div style="height:14px"></div>

    ${raw(card(
      'Decisions needed before Phase 2 can be built',
      `<ul style="margin:0;padding-left:18px;color:var(--text-dim);font-size:13px;line-height:1.75">
        <li>What "Accounts Cleared" means in writing — full payment received, or approved credit terms?</li>
        <li>Who owns each handoff, by name. The shared record is worth nothing if quotations still confirm
            orders over WhatsApp.</li>
        <li>Reorder points per SKU or per category, and formal credit limits per customer. Both are business
            decisions, not technical ones, and Phase 4 cannot enforce what has not been decided.</li>
      </ul>`
    ))}
  `;
}
