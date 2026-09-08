/**
 * Simulated TallyPrime.
 *
 * This is a real HTTP server that speaks TallyPrime's XML/HTTP interface —
 * the same protocol the live Tally at Exchange > Data Synchronization exposes
 * on port 9000. The application talks to it with the exact same client code it
 * will use against the real thing.
 *
 * To cut over to the real Tally: set TALLY_MODE=live and TALLY_HOST to the
 * Tally machine's IP. This file is then never loaded.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { buildCompany, driftStock } from './mock-data.js';

/**
 * The stock the simulated company actually holds, written by the catalogue
 * importer. A file, not a database read, because the fake Tally is standing in
 * for a separate system and should not reach into the app's own store.
 */
function loadStockSeed() {
  const seedPath = path.join(config.root, 'data', 'tally-seed.json');
  try {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    return Array.isArray(seed.items) ? seed.items : null;
  } catch {
    return null; // no price list imported yet — fall back to invented products
  }
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pad = (n, w = 2) => String(n).padStart(w, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const amt = (n) => Number(n).toFixed(2);

// ---------------------------------------------------------------------------
// Response builders — shaped like real Tally exports
// ---------------------------------------------------------------------------
function envelope(inner) {
  return `<ENVELOPE>\n<HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER>\n<BODY>\n<DATA>\n${inner}\n</DATA>\n</BODY>\n</ENVELOPE>`;
}

function errorEnvelope(message) {
  return `<ENVELOPE>\n<HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER>\n<BODY>\n<DATA>\n<LINEERROR>${esc(message)}</LINEERROR>\n</DATA>\n</BODY>\n</ENVELOPE>`;
}

function companiesXml(company) {
  return envelope(
    `<COLLECTION>\n<COMPANY NAME="${esc(company.companyName)}" RESERVEDNAME="">` +
      `<NAME>${esc(company.companyName)}</NAME>` +
      `<STARTINGFROM>${ymd(company.booksFrom)}</STARTINGFROM>` +
      `<STATENAME>Madhya Pradesh</STATENAME>` +
      `<GSTREGISTRATIONNUMBER>23AAAPB1234C1ZR</GSTREGISTRATIONNUMBER>` +
      `</COMPANY>\n</COLLECTION>`
  );
}

/**
 * The group tree, mirroring how a real company nests its parties.
 *
 * Every sub-group here names its PARENT and leaves PRIMARYGROUP empty, which is
 * the harder of the two shapes the client has to cope with: it forces the walk
 * up the chain rather than handing over the answer in one field.
 */
function groupsXml(company) {
  const parents = new Set(company.ledgers.map((l) => l.parent).filter(Boolean));
  const primaries = ['Sundry Debtors', 'Sundry Creditors'];

  const rows = [];
  for (const name of primaries) {
    rows.push(`<GROUP NAME="${esc(name)}" RESERVEDNAME="${esc(name)}"><PARENT></PARENT><PRIMARYGROUP></PRIMARYGROUP></GROUP>`);
  }
  for (const name of parents) {
    if (primaries.includes(name)) continue;
    // Anything that is not a party sub-group hangs off itself and resolves to
    // neither, which is what Tally reports for Bank and expense groups too.
    const under = /debtor|trader|customer/i.test(name) ? 'Sundry Debtors' : '';
    rows.push(
      `<GROUP NAME="${esc(name)}" RESERVEDNAME=""><PARENT>${esc(under)}</PARENT><PRIMARYGROUP></PRIMARYGROUP></GROUP>`
    );
  }
  return envelope(`<COLLECTION>\n${rows.join('\n')}\n</COLLECTION>`);
}

function ledgersXml(company) {
  const rows = company.ledgers
    .map(
      (l) =>
        `<LEDGER NAME="${esc(l.name)}" RESERVEDNAME="">` +
        `<GUID>${esc(l.guid)}</GUID>` +
        `<PARENT>${esc(l.parent)}</PARENT>` +
        `<LEDGERPHONE>${esc(l.contact)}</LEDGERPHONE>` +
        `<PARTYGSTIN>${esc(l.gstin)}</PARTYGSTIN>` +
        `<LEDSTATENAME>${esc(l.state)}</LEDSTATENAME>` +
        `<CREDITPERIOD>${l.creditPeriodDays ? `${l.creditPeriodDays} Days` : ''}</CREDITPERIOD>` +
        `<CREDITLIMIT>${amt(l.creditLimit || 0)}</CREDITLIMIT>` +
        `<OPENINGBALANCE>${amt(l.openingBalance)}</OPENINGBALANCE>` +
        `<CLOSINGBALANCE>${amt(l.closingBalance)}</CLOSINGBALANCE>` +
        `</LEDGER>`
    )
    .join('\n');
  return envelope(`<COLLECTION>\n${rows}\n</COLLECTION>`);
}

function stockItemsXml(company) {
  const rows = company.stockItems
    .map(
      (s) =>
        `<STOCKITEM NAME="${esc(s.name)}" RESERVEDNAME="">` +
        `<GUID>${esc(s.guid)}</GUID>` +
        `<PARENT>${esc(s.parent)}</PARENT>` +
        `<CATEGORY>${esc(s.category)}</CATEGORY>` +
        `<PARTNO>${esc(s.partNumber)}</PARTNO>` +
        `<ALIAS>${esc(s.alias)}</ALIAS>` +
        `<BASEUNITS>${esc(s.baseUnits)}</BASEUNITS>` +
        `<GSTHSNCODE>${esc(s.hsn)}</GSTHSNCODE>` +
        `<GSTRATE>${s.gstRate}</GSTRATE>` +
        `<REORDERLEVEL>${s.reorderLevel} ${esc(s.baseUnits)}</REORDERLEVEL>` +
        `<STANDARDPRICE>${amt(s.sellRate)}</STANDARDPRICE>` +
        `<CLOSINGBALANCE>${s.closingQty} ${esc(s.baseUnits)}</CLOSINGBALANCE>` +
        `<CLOSINGRATE>${amt(s.costRate)}/${esc(s.baseUnits)}</CLOSINGRATE>` +
        `<CLOSINGVALUE>${amt(s.closingQty * s.costRate)}</CLOSINGVALUE>` +
        `</STOCKITEM>`
    )
    .join('\n');
  return envelope(`<COLLECTION>\n${rows}\n</COLLECTION>`);
}

function billsXml(company) {
  const rows = company.bills
    .filter((b) => b.closingAmount > 0.01)
    .map(
      (b) =>
        `<BILLS NAME="${esc(b.billRef)}">` +
        `<BILLDATE>${ymd(b.billDate)}</BILLDATE>` +
        `<BILLDUEDATE>${ymd(b.dueDate)}</BILLDUEDATE>` +
        `<PARTYLEDGERNAME>${esc(b.partyName)}</PARTYLEDGERNAME>` +
        `<BILLCREDITPERIOD>${b.creditPeriodDays} Days</BILLCREDITPERIOD>` +
        `<OPENINGBALANCE>${amt(-b.openingAmount)}</OPENINGBALANCE>` +
        `<CLOSINGBALANCE>${amt(-b.closingAmount)}</CLOSINGBALANCE>` +
        `</BILLS>`
    )
    .join('\n');
  return envelope(`<COLLECTION>\n${rows}\n</COLLECTION>`);
}

function vouchersXml(company, fromDate, toDate) {
  const rows = company.vouchers
    .filter((v) => (!fromDate || v.date >= fromDate) && (!toDate || v.date <= toDate))
    .map((v) => {
      const lines = v.lines
        .map(
          (li) =>
            `<ALLINVENTORYENTRIES.LIST>` +
            `<STOCKITEMNAME>${esc(li.item)}</STOCKITEMNAME>` +
            `<ACTUALQTY>${li.qty} ${esc(li.units)}</ACTUALQTY>` +
            `<RATE>${amt(li.rate)}/${esc(li.units)}</RATE>` +
            `<AMOUNT>${amt(li.amount)}</AMOUNT>` +
            `</ALLINVENTORYENTRIES.LIST>`
        )
        .join('');
      return (
        `<VOUCHER VCHTYPE="${esc(v.type)}" ACTION="None">` +
        `<GUID>${esc(v.guid)}</GUID>` +
        `<DATE>${ymd(v.date)}</DATE>` +
        `<VOUCHERTYPENAME>${esc(v.type)}</VOUCHERTYPENAME>` +
        `<VOUCHERNUMBER>${esc(v.number)}</VOUCHERNUMBER>` +
        `<PARTYLEDGERNAME>${esc(v.partyName)}</PARTYLEDGERNAME>` +
        `<REFERENCE>${esc(v.reference)}</REFERENCE>` +
        `<NARRATION>${esc(v.narration)}</NARRATION>` +
        `<AMOUNT>${amt(v.amount)}</AMOUNT>` +
        lines +
        `</VOUCHER>`
      );
    })
    .join('\n');
  return envelope(`<COLLECTION>\n${rows}\n</COLLECTION>`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
function parseTallyDate(s, endOfDay = false) {
  if (!s || String(s).length !== 8) return null;
  const t = String(s);
  const d = new Date(Number(t.slice(0, 4)), Number(t.slice(4, 6)) - 1, Number(t.slice(6, 8)));
  // SVTODATE is inclusive of the whole day in Tally, so a voucher stamped at
  // 3pm today must still fall inside a window ending today.
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d;
}

export function createMockTallyServer({ seed = 'balaji-2026', failureRate = 0, latencyMs = 100, company: companyName = 'Balaji Enterprises', log = () => {} } = {}) {
  const bootedAt = Date.now();
  const stockSeed = loadStockSeed();
  const company = buildCompany(seed, new Date(), stockSeed);
  company.companyName = companyName;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));

      const send = (xml, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'text/xml; charset=utf-16', 'Content-Length': Buffer.byteLength(xml) });
        res.end(xml);
      };

      if (req.method === 'GET') {
        // Real Tally answers a bare GET with a small status page.
        return send('<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC>TallyPrime Server (simulated)</DESC></BODY></ENVELOPE>');
      }

      if (failureRate > 0 && Math.random() < failureRate) {
        log('simulated failure');
        return send(errorEnvelope('Tally is busy. Please try again.'), 200);
      }

      let parsed;
      try {
        parsed = parser.parse(body);
      } catch {
        return send(errorEnvelope('Malformed XML request'), 200);
      }

      const env = parsed?.ENVELOPE;
      if (!env) return send(errorEnvelope('Missing ENVELOPE'), 200);

      const header = env.HEADER || {};
      const request = String(header.TALLYREQUEST || '');
      const id = String(header.ID || '');
      const sv = env.BODY?.DESC?.STATICVARIABLES || {};
      const requestedCompany = sv.SVCURRENTCOMPANY;

      if (requestedCompany && requestedCompany !== company.companyName) {
        return send(errorEnvelope(`Could not find Company '${requestedCompany}'`), 200);
      }

      driftStock(company, (Date.now() - bootedAt) / 60000);

      // Import used to be accepted here, for the write-back phase that is no
      // longer being built. It is refused rather than left in place, and the
      // refusal is the point: this simulator is where an accidental write
      // would first show up, and one that quietly answered CREATED:1 would
      // let it pass every test and only be discovered against the real Tally
      // in the office. Anything that is not a read fails loudly instead.
      if (request === 'Import') {
        log('REFUSED import — this ERP does not write to Tally');
        return send(
          errorEnvelope('This company is read-only to the ERP. Write-back was dropped; vouchers are raised in Tally.'),
          200
        );
      }

      if (request !== 'Export') return send(errorEnvelope(`Unsupported TALLYREQUEST '${request}'`), 200);

      log(`export: ${id}`);
      switch (id) {
        case 'List of Companies':
          return send(companiesXml(company));
        case 'BE List of Groups':
          return send(groupsXml(company));
        case 'BE List of Ledgers':
          return send(ledgersXml(company));
        case 'BE List of StockItems':
          return send(stockItemsXml(company));
        case 'BE Bills Receivable':
          return send(billsXml(company));
        case 'BE Day Book':
          return send(vouchersXml(company, parseTallyDate(sv.SVFROMDATE), parseTallyDate(sv.SVTODATE, true)));
        default:
          return send(errorEnvelope(`Could not find Report '${id}'`), 200);
      }
    });
  });

  return { server, company };
}

/**
 * Start the fake Tally, standing aside if its port is already taken.
 *
 * A second instance of the app — a demo alongside the working one, two chats,
 * a colleague's copy — would otherwise die on boot with EADDRINUSE from a
 * simulated dependency, which is an absurd reason to be unable to look at the
 * dashboard. So it moves to whatever port is free and reports where it went.
 *
 * This applies to the SIMULATION ONLY, and the distinction matters. In live
 * mode there is no listener here at all: TALLY_PORT is the port TallyPrime is
 * serving on over on the office machine, and quietly "falling back" to a
 * different one would mean connecting to nothing while claiming success.
 */
export function startMockTally(opts = {}) {
  const { server, ...rest } = createMockTallyServer(opts);
  const wanted = opts.port ?? 9000;
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code !== 'EADDRINUSE') return reject(err);
      console.warn(`[tally] port ${wanted} is already in use — the simulated Tally is taking a free port instead.`);
      // 0 asks the OS for any free port; the app then reads it back off the
      // server rather than guessing, so the client is pointed at the real one.
      server.listen(0, '127.0.0.1', settled);
    };
    const settled = () => {
      server.off('error', onError);
      resolve({ server, port: server.address().port, ...rest });
    };
    server.on('error', onError);
    server.listen(wanted, '127.0.0.1', settled);
  });
}
