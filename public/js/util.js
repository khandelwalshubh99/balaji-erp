// --- data ------------------------------------------------------------------
export async function api(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Signed out');
  }
  const body = await res.text();
  let data;
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    // A non-JSON body from an API route means something upstream answered
    // instead of the app — surface it rather than rendering an empty screen.
    throw new Error(`Unexpected response from ${path} (${res.status})`);
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// --- formatting ------------------------------------------------------------
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Full rupee figure: 17,64,318 */
export const rupees = (n) => `₹${inr.format(Math.round(Number(n) || 0))}`;
export const rupees2 = (n) => `₹${inr2.format(Number(n) || 0)}`;

/** Compact Indian scale: ₹1.76 Cr / ₹12.4 L / ₹4,520 */
export function money(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  return `${sign}₹${inr.format(Math.round(abs))}`;
}

export const qty = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number(n) || 0);
export const count = (n) => inr.format(Number(n) || 0);

// --- plain calendar dates (mirrors src/lib/dates.js) -----------------------
// Local parts, never toISOString(): in IST that would report yesterday's date
// for the whole of the working morning.
export const toISODate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const todayISO = () => toISODate(new Date());

export function addDaysISO(iso, days) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return toISODate(new Date(y, m - 1, d + days));
}

export function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export function dateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function ago(iso) {
  if (!iso) return 'never';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} h ago`;
  return `${Math.floor(secs / 86400)} d ago`;
}

// --- tiny DOM helpers ------------------------------------------------------
export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Tagged template that escapes interpolations. Use ${raw(html)} to opt out. */
export function html(strings, ...values) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const chunk = Array.isArray(v)
      ? v.map((x) => (x && x.__raw ? x.value : esc(x))).join('')
      : v && v.__raw
      ? v.value
      : esc(v);
    return out + chunk + s;
  }, '');
}
export const raw = (value) => ({ __raw: true, value });

export function card(title, bodyHtml, { note = '', flush = false, actions = '' } = {}) {
  return html`<section class="card">
    <header>
      <h2>${title}</h2>
      <div class="spacer"></div>
      ${raw(note ? `<span class="note">${esc(note)}</span>` : '')}
      ${raw(actions)}
    </header>
    <div class="body ${raw(flush ? 'flush' : '')}">${raw(bodyHtml)}</div>
  </section>`;
}

export function kpi({ label, value, sub = '', tone = '' }) {
  return html`<div class="card kpi">
    <div class="label">${label}</div>
    <div class="value ${raw(tone)}">${raw(value)}</div>
    <div class="sub">${raw(sub)}</div>
  </div>`;
}

export const emptyState = (msg) => `<div class="empty">${esc(msg)}</div>`;

/** Minimal inline sparkline — no chart library, no CDN. */
export function sparkline(points, { height = 56, stroke = 'var(--accent)' } = {}) {
  const vals = points.map((p) => Number(p) || 0);
  if (vals.length < 2) return '<div class="empty">Not enough data yet</div>';
  const max = Math.max(...vals, 1);
  const w = 100;
  const step = w / (vals.length - 1);
  const y = (v) => height - 6 - (v / max) * (height - 12);
  const line = vals.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const area = `0,${height} ${line} ${w},${height}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="${area}" fill="${stroke}" opacity="0.12"></polygon>
    <polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="1.4"
      vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"></polyline>
  </svg>`;
}

export function bar(fraction, tone = 'var(--accent)') {
  const pct = Math.max(0, Math.min(1, Number(fraction) || 0)) * 100;
  return `<div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${tone}"></div></div>`;
}
