/**
 * The copy-for-email quotation.
 *
 * Deliberately a faithful port of the existing Balaji Quotation Platform's
 * output — same layout, same inline-styled table, same black header row — so
 * that what lands in a customer's inbox does not change the day this replaces
 * that tool. Inline styles because email clients strip stylesheets.
 *
 * The one addition is the customer block, which the old tool had nowhere to
 * put.
 */
import { priceLine, QUOTE_VALIDITY_DAYS } from './service.js';

const F = 'font-family:Arial,Helvetica,sans-serif;';
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const inr = (n) =>
  `₹${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const ddmmyyyy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso || '');
};

export const DEFAULT_TERMS = [
  `This quotation is valid for ${QUOTE_VALIDITY_DAYS} days from the date of issue.`,
  'Goods once sold will not be taken back unless due to manufacturing defect.',
  'Freight charges are additional unless stated otherwise.',
].join('\n');

export function renderQuotationHtml(quote, { showRemarks = false, logoDataUri = '' } = {}) {
  const th = `${F}padding:7px 8px;border:1px solid #161616;background-color:#161616;color:#ffffff;font-size:12px;font-weight:bold;text-align:left;`;
  const thr = th.replace('text-align:left', 'text-align:right');
  const td = `${F}padding:7px 8px;border:1px solid #d6d5d0;font-size:13px;color:#161616;text-align:left;vertical-align:top;`;
  const tdr = td.replace('text-align:left', 'text-align:right');

  const lines = quote.lines.map((l, i) => ({ ...l, sno: i + 1, ...priceLine({
    qty: l.qty, rate: l.rate, discountPct: l.discount_pct, gstRate: l.gst_rate,
  }) }));
  const subtotal = lines.reduce((a, l) => a + l.taxable, 0);
  const gst = lines.reduce((a, l) => a + l.gstAmount, 0);

  let h = `<div style="${F}color:#161616;font-size:13px;">`;

  // Masthead
  h += `<table cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;width:100%;${F}"><tr>`;
  h += `<td style="${F}padding:0 0 14px 0;vertical-align:middle;text-align:left;border-bottom:2px solid #161616;">`;
  if (logoDataUri) {
    h += `<img src="${logoDataUri}" width="52" height="52" alt="Balaji Enterprises" style="width:52px;height:52px;vertical-align:middle;border:0;">&nbsp;&nbsp;`;
  }
  h += `<span style="${F}font-size:20px;font-weight:bold;letter-spacing:1px;vertical-align:middle;">BALAJI ENTERPRISES</span>`;
  h += `<div style="${F}font-size:13px;font-weight:bold;letter-spacing:2px;color:#C75E12;padding-left:2px;">QUOTATION</div>`;
  h += `</td>`;
  h += `<td style="${F}padding:0 0 14px 0;vertical-align:bottom;text-align:right;border-bottom:2px solid #161616;">`;
  h += `<div style="${F}font-size:11px;letter-spacing:1px;color:#6f6f6f;">QUOTATION NO</div>`;
  h += `<div style="${F}font-size:15px;font-weight:bold;">${esc(quote.quote_number)}${quote.version > 1 ? ` <span style="font-weight:normal;color:#6f6f6f;">rev ${quote.version}</span>` : ''}</div>`;
  h += `<div style="${F}font-size:11px;letter-spacing:1px;color:#6f6f6f;padding-top:6px;">DATE</div>`;
  h += `<div style="${F}font-size:15px;font-weight:bold;">${ddmmyyyy(quote.quote_date || quote.created_at)}</div>`;
  if (quote.valid_until) {
    h += `<div style="${F}font-size:11px;letter-spacing:1px;color:#6f6f6f;padding-top:6px;">VALID UNTIL</div>`;
    h += `<div style="${F}font-size:15px;font-weight:bold;">${ddmmyyyy(quote.valid_until)}</div>`;
  }
  h += `</td></tr></table>`;

  // Customer — the part the standalone tool had no field for.
  if (quote.customer_name) {
    h += `<table cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin-top:14px;${F}"><tr>`;
    h += `<td style="${F}font-size:11px;letter-spacing:1px;color:#6f6f6f;padding:0 0 3px 0;">TO</td></tr><tr>`;
    h += `<td style="${F}font-size:15px;font-weight:bold;">${esc(quote.customer_name)}</td></tr></table>`;
  }

  // Items
  h += `<table cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;width:100%;margin-top:16px;${F}"><tr>`;
  h += `<th style="${th}width:36px;">S No</th><th style="${th}">Brand</th><th style="${th}">Part No</th>`;
  h += `<th style="${th}">Description</th><th style="${th}">HSN</th><th style="${thr}">Price</th>`;
  h += `<th style="${thr}">Qty</th><th style="${th}">UoM</th><th style="${thr}">Disc %</th>`;
  h += `<th style="${thr}">GST %</th><th style="${thr}">Line Total</th>`;
  if (showRemarks) h += `<th style="${th}">Remarks</th>`;
  h += `</tr>`;

  for (const l of lines) {
    h += `<tr>`;
    h += `<td style="${td}color:#6f6f6f;">${l.sno}</td>`;
    h += `<td style="${td}font-weight:bold;">${esc(l.brand || '')}</td>`;
    h += `<td style="${td}">${esc(l.item_code || '')}</td>`;
    h += `<td style="${td}">${esc(l.item_name)}</td>`;
    h += `<td style="${td}">${esc(l.hsn || '')}</td>`;
    h += `<td style="${tdr}">${inr(l.rate)}</td>`;
    h += `<td style="${tdr}">${l.qty}</td>`;
    h += `<td style="${td}">${esc(l.units || '')}</td>`;
    h += `<td style="${tdr}">${l.discount_pct || 0}</td>`;
    h += `<td style="${tdr}">${l.gst_rate || 0}</td>`;
    h += `<td style="${tdr}font-weight:bold;">${inr(l.taxable)}</td>`;
    if (showRemarks) h += `<td style="${td}">${esc(l.remarks || '')}</td>`;
    h += `</tr>`;
  }
  h += `</table>`;

  // Totals
  const totalRow = (label, value, bold) =>
    `<tr><td style="${tdr}border:0;padding:4px 8px;${bold ? 'font-weight:bold;font-size:15px;' : ''}">${label}</td>` +
    `<td style="${tdr}border:0;padding:4px 8px;width:140px;${bold ? 'font-weight:bold;font-size:15px;' : ''}">${inr(value)}</td></tr>`;

  h += `<table cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;width:100%;margin-top:10px;${F}">`;
  h += totalRow('Subtotal', subtotal);
  h += totalRow('GST', gst);
  h += `<tr><td colspan="2" style="border:0;padding:0;"><div style="border-top:2px solid #161616;height:1px;font-size:0;">&nbsp;</div></td></tr>`;
  h += totalRow('Total', subtotal + gst, true);
  h += `</table>`;

  // Terms
  const terms = (quote.notes || DEFAULT_TERMS).split('\n').filter(Boolean);
  if (terms.length) {
    h += `<div style="${F}margin-top:18px;padding-top:12px;border-top:1px solid #d6d5d0;">`;
    h += `<div style="${F}font-size:11px;letter-spacing:1px;color:#6f6f6f;padding-bottom:5px;">TERMS</div>`;
    for (const t of terms) h += `<div style="${F}font-size:12px;color:#373737;padding:1px 0;">${esc(t)}</div>`;
    h += `</div>`;
  }

  h += `</div>`;
  return h;
}

/** Plain-text fallback, for WhatsApp and clients that strip HTML. */
export function renderQuotationText(quote) {
  const lines = quote.lines.map((l, i) => {
    const p = priceLine({ qty: l.qty, rate: l.rate, discountPct: l.discount_pct, gstRate: l.gst_rate });
    return `${i + 1}. ${l.item_code ? `[${l.item_code}] ` : ''}${l.item_name}\n` +
      `   ${l.qty} ${l.units} x ${inr(l.rate)}` +
      `${l.discount_pct ? ` less ${l.discount_pct}%` : ''} = ${inr(p.taxable)} + ${l.gst_rate}% GST`;
  });
  const subtotal = quote.lines.reduce(
    (a, l) => a + priceLine({ qty: l.qty, rate: l.rate, discountPct: l.discount_pct, gstRate: l.gst_rate }).taxable, 0);
  const gst = quote.lines.reduce(
    (a, l) => a + priceLine({ qty: l.qty, rate: l.rate, discountPct: l.discount_pct, gstRate: l.gst_rate }).gstAmount, 0);

  return [
    'BALAJI ENTERPRISES — QUOTATION',
    `${quote.quote_number}${quote.version > 1 ? ` (rev ${quote.version})` : ''}   ${ddmmyyyy(quote.quote_date || quote.created_at)}`,
    quote.valid_until ? `Valid until ${ddmmyyyy(quote.valid_until)}` : '',
    quote.customer_name ? `To: ${quote.customer_name}` : '',
    '',
    ...lines,
    '',
    `Subtotal  ${inr(subtotal)}`,
    `GST       ${inr(gst)}`,
    `Total     ${inr(subtotal + gst)}`,
    '',
    quote.notes || DEFAULT_TERMS,
  ].filter((l) => l !== '').join('\n');
}
