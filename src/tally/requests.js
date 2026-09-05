/**
 * TallyPrime XML request builders.
 *
 * These are real Tally requests — each one ships its own TDL collection
 * definition, so nothing has to be installed inside Tally beforehand. They are
 * sent unchanged to the simulated Tally today and to the office Tally later.
 */

const escape = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function exportRequest({ id, company, tdl, staticVars = {} }) {
  const vars = Object.entries({
    SVEXPORTFORMAT: '$$SysName:XML',
    ...(company ? { SVCURRENTCOMPANY: company } : {}),
    ...staticVars,
  })
    .map(([k, v]) => `      <${k}>${escape(v)}</${k}>`)
    .join('\n');

  return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>${escape(id)}</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
${vars}
   </STATICVARIABLES>${tdl ? `\n   <TDL>\n    <TDLMESSAGE>\n${tdl}\n    </TDLMESSAGE>\n   </TDL>` : ''}
  </DESC>
 </BODY>
</ENVELOPE>`;
}

const fetchList = (fields) => fields.map((f) => `      <NATIVEMETHOD>${f}</NATIVEMETHOD>`).join('\n');

/** Phase 0: the smallest possible "is anyone home?" request. */
export function listCompanies() {
  return `<ENVELOPE>
 <HEADER>
  <VERSION>1</VERSION>
  <TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE>
  <ID>List of Companies</ID>
 </HEADER>
 <BODY>
  <DESC>
   <STATICVARIABLES>
    <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   </STATICVARIABLES>
   <TDL>
    <TDLMESSAGE>
     <COLLECTION NAME="List of Companies" ISINITIALIZE="Yes">
      <TYPE>Company</TYPE>
      <NATIVEMETHOD>Name</NATIVEMETHOD>
      <NATIVEMETHOD>StartingFrom</NATIVEMETHOD>
     </COLLECTION>
    </TDLMESSAGE>
   </TDL>
  </DESC>
 </BODY>
</ENVELOPE>`;
}

export function listLedgers(company) {
  return exportRequest({
    id: 'BE List of Ledgers',
    company,
    tdl: `     <COLLECTION NAME="BE List of Ledgers" ISINITIALIZE="Yes">
      <TYPE>Ledger</TYPE>
${fetchList(['Name', 'Guid', 'Parent', 'LedgerPhone', 'PartyGSTIN', 'LedStateName', 'CreditPeriod', 'CreditLimit', 'OpeningBalance', 'ClosingBalance'])}
     </COLLECTION>`,
  });
}

export function listStockItems(company) {
  return exportRequest({
    id: 'BE List of StockItems',
    company,
    tdl: `     <COLLECTION NAME="BE List of StockItems" ISINITIALIZE="Yes">
      <TYPE>StockItem</TYPE>
${fetchList(['Name', 'Guid', 'Parent', 'Category', 'PartNo', 'Alias', 'BaseUnits', 'GSTHSNCode', 'GSTRate', 'ReorderLevel', 'StandardPrice', 'ClosingBalance', 'ClosingRate', 'ClosingValue'])}
     </COLLECTION>`,
  });
}

/**
 * Outstanding sales bills, bill-by-bill.
 *
 * NOTE FOR CUTOVER: of all five requests here, this is the one most likely to
 * need tweaking against the real company data — bill collections behave
 * differently depending on whether "Maintain bill-wise details" is on and how
 * bill references were entered. Verify this one first on the Tally Connection
 * page before trusting the receivables screen.
 */
export function listBillsReceivable(company) {
  return exportRequest({
    id: 'BE Bills Receivable',
    company,
    tdl: `     <COLLECTION NAME="BE Bills Receivable" ISINITIALIZE="Yes">
      <TYPE>Bills</TYPE>
      <FILTERS>BEIsReceivable</FILTERS>
${fetchList(['Name', 'BillDate', 'BillDueDate', 'PartyLedgerName', 'BillCreditPeriod', 'OpeningBalance', 'ClosingBalance'])}
     </COLLECTION>
     <SYSTEM TYPE="Formulae" NAME="BEIsReceivable">$$IsDr:$ClosingBalance AND $$NotEmpty:$ClosingBalance</SYSTEM>`,
  });
}

/** Vouchers in a date window — Sales Orders, Delivery Notes, Sales, Receipts. */
export function dayBook(company, fromDate, toDate) {
  const d = (x) =>
    `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
  return exportRequest({
    id: 'BE Day Book',
    company,
    staticVars: { SVFROMDATE: d(fromDate), SVTODATE: d(toDate) },
    tdl: `     <COLLECTION NAME="BE Day Book" ISINITIALIZE="Yes">
      <TYPE>Voucher</TYPE>
${fetchList(['Guid', 'Date', 'VoucherTypeName', 'VoucherNumber', 'PartyLedgerName', 'Reference', 'Narration', 'Amount'])}
      <FETCH>AllInventoryEntries.*</FETCH>
     </COLLECTION>`,
  });
}
