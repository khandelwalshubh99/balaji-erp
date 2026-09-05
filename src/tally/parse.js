/**
 * Parsers for TallyPrime XML responses.
 *
 * Everything Tally-specific and ugly lives here: the UTF-16 responses, the
 * "142 Nos" quantity strings, the sign convention where a debit balance is
 * exported as a negative number. The rest of the app sees clean objects.
 */
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false, // keep everything as strings; we coerce deliberately
});

export class TallyResponseError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = 'TallyResponseError';
    this.raw = raw;
  }
}

/** Tally replies in UTF-16 by default and sprinkles in illegal control chars. */
export function decodeTallyBuffer(buf) {
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le', 2);
  else if (buf.length >= 2 && buf[0] !== 0x00 && buf[1] === 0x00) text = buf.toString('utf16le');
  else text = buf.toString('utf8');
  return text
    .replace(/&#[0-9]{1,2};/g, '') // Tally emits &#4; and friends inside text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();
}

export function parseEnvelope(xml) {
  const doc = parser.parse(xml);
  const env = doc.ENVELOPE ?? doc;
  const err = env?.BODY?.DATA?.LINEERROR ?? env?.BODY?.DESC?.LINEERROR;
  if (err) throw new TallyResponseError(String(err), xml);
  return env;
}

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function collection(env, tag) {
  const col = env?.BODY?.DATA?.COLLECTION;
  if (!col) return [];
  return asArray(col[tag]);
}

// --- field coercion --------------------------------------------------------
const text = (v) =>
  v === undefined || v === null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v);

/** "-45000.00" -> -45000 ; "" -> 0 */
export const toAmount = (v) => {
  const n = parseFloat(text(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** "142 Nos" -> { qty: 142, units: 'Nos' } ; "-3 Pkt" -> { qty: -3, ... } */
export const toQuantity = (v) => {
  const s = text(v).trim();
  const m = s.match(/^(-?[\d.,]+)\s*(.*)$/);
  if (!m) return { qty: 0, units: '' };
  return { qty: parseFloat(m[1].replace(/,/g, '')) || 0, units: m[2].trim() };
};

/** "200.00/Nos" -> 200 */
export const toRate = (v) => toAmount(text(v).split('/')[0]);

/** "20260712" -> "2026-07-12" (null if unparseable) */
export const toISODate = (v) => {
  const s = text(v).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** "30 Days" -> 30 */
export const toDays = (v) => {
  const m = text(v).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
};

// --- record shapers --------------------------------------------------------
export function parseCompanies(xml) {
  const env = parseEnvelope(xml);
  return collection(env, 'COMPANY').map((c) => ({
    name: text(c['@_NAME'] || c.NAME),
    startingFrom: toISODate(c.STARTINGFROM),
    gstin: text(c.GSTREGISTRATIONNUMBER),
  }));
}

export function parseLedgers(xml) {
  const env = parseEnvelope(xml);
  return collection(env, 'LEDGER').map((l) => {
    const closing = toAmount(l.CLOSINGBALANCE);
    const parent = text(l.PARENT);
    return {
      guid: text(l.GUID) || text(l['@_NAME']),
      name: text(l['@_NAME'] || l.NAME),
      parent,
      isCustomer: /debtors/i.test(parent),
      isSupplier: /creditors/i.test(parent),
      phone: text(l.LEDGERPHONE),
      gstin: text(l.PARTYGSTIN),
      state: text(l.LEDSTATENAME),
      creditPeriodDays: toDays(l.CREDITPERIOD),
      creditLimit: toAmount(l.CREDITLIMIT),
      openingBalance: toAmount(l.OPENINGBALANCE),
      closingBalance: closing,
      // Tally exports a debit balance as negative. A customer who owes us money
      // is in debit, so what they owe is the negated closing balance.
      outstanding: closing < 0 ? -closing : 0,
    };
  });
}

export function parseStockItems(xml) {
  const env = parseEnvelope(xml);
  return collection(env, 'STOCKITEM').map((s) => {
    const bal = toQuantity(s.CLOSINGBALANCE);
    const reorder = toQuantity(s.REORDERLEVEL);
    return {
      guid: text(s.GUID) || text(s['@_NAME']),
      name: text(s['@_NAME'] || s.NAME),
      alias: text(s.ALIAS),
      partNumber: text(s.PARTNO),
      category: text(s.CATEGORY) || text(s.PARENT),
      group: text(s.PARENT),
      baseUnits: text(s.BASEUNITS) || bal.units,
      hsn: text(s.GSTHSNCODE),
      gstRate: toAmount(s.GSTRATE),
      reorderLevel: reorder.qty,
      standardPrice: toAmount(s.STANDARDPRICE),
      closingQty: bal.qty,
      closingRate: toRate(s.CLOSINGRATE),
      closingValue: toAmount(s.CLOSINGVALUE),
    };
  });
}

export function parseBills(xml) {
  const env = parseEnvelope(xml);
  return collection(env, 'BILLS').map((b) => ({
    billRef: text(b['@_NAME'] || b.NAME),
    partyName: text(b.PARTYLEDGERNAME),
    billDate: toISODate(b.BILLDATE),
    dueDate: toISODate(b.BILLDUEDATE),
    creditPeriodDays: toDays(b.BILLCREDITPERIOD),
    openingAmount: Math.abs(toAmount(b.OPENINGBALANCE)),
    amount: Math.abs(toAmount(b.CLOSINGBALANCE)),
  }));
}

export function parseVouchers(xml) {
  const env = parseEnvelope(xml);
  return collection(env, 'VOUCHER').map((v) => {
    const lines = asArray(v['ALLINVENTORYENTRIES.LIST']).map((li) => {
      const q = toQuantity(li.ACTUALQTY);
      return {
        itemName: text(li.STOCKITEMNAME),
        qty: q.qty,
        units: q.units,
        rate: toRate(li.RATE),
        amount: toAmount(li.AMOUNT),
      };
    });
    return {
      guid: text(v.GUID),
      voucherType: text(v.VOUCHERTYPENAME || v['@_VCHTYPE']),
      voucherNumber: text(v.VOUCHERNUMBER),
      date: toISODate(v.DATE),
      partyName: text(v.PARTYLEDGERNAME),
      reference: text(v.REFERENCE),
      narration: text(v.NARRATION),
      amount: Math.abs(toAmount(v.AMOUNT)),
      lines,
    };
  });
}
