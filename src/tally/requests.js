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

/**
 * The group tree, so a ledger can be told what it actually is.
 *
 * A ledger's PARENT is only its immediate group, and in a real company that is
 * rarely one of Tally's own names: the office books keep customers under groups
 * like "Ajay Ji (Debtor)" and "RAJESH SIR ( INDUSTRIES AND TRADERS)", named
 * after whoever handles the account. Matching those names against /debtors/i
 * classified some of them and silently missed the rest. The names carry no rule
 * worth reading, so the tree is walked to a primary group instead.
 */
export function listGroups(company) {
  return exportRequest({
    id: 'BE List of Groups',
    company,
    tdl: `     <COLLECTION NAME="BE List of Groups" ISINITIALIZE="Yes">
      <TYPE>Group</TYPE>
${fetchList(['Name', 'Parent', 'PrimaryGroup', 'IsRevenue', 'IsDeemedPositive'])}
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
 * The note that used to sit here guessed that this request would be the one to
 * need tweaking against real data, and it was right. Against the office books
 * the `$$IsDr:$ClosingBalance` filter matched nothing and Tally answered with a
 * bare CMPINFO block instead of a collection — no error, no rows, just company
 * counts, which reads from the app as "no outstanding bills".
 *
 * So the filter is gone rather than rewritten. Receivable is decided here, in
 * `parseBills`, from the sign of the closing balance. A TDL formula that
 * silently matches nothing is indistinguishable from a company with nothing
 * outstanding; the same mistake in JavaScript is a visible bug. This collection
 * is small enough — it holds outstanding bills, not history — that fetching it
 * whole and narrowing afterwards costs little.
 */
export function listBillsReceivable(company) {
  return exportRequest({
    id: 'BE Bills Receivable',
    company,
    tdl: `     <COLLECTION NAME="BE Bills Receivable" ISINITIALIZE="Yes">
      <TYPE>Bills</TYPE>
${fetchList(['Name', 'BillDate', 'BillDueDate', 'PartyLedgerName', 'BillCreditPeriod', 'OpeningBalance', 'ClosingBalance'])}
     </COLLECTION>`,
  });
}

/**
 * Vouchers in a date window — Sales Orders, Delivery Notes, Sales, Receipts.
 *
 * The date window has to be a FILTER, not just SVFROMDATE and SVTODATE. A bare
 * Voucher collection does not read those variables: it enumerates every voucher
 * the company has ever recorded and leaves the caller to narrow it afterwards.
 * Against the office books that request never returned — and because it was the
 * collection being unbounded rather than the window being wide, asking for one
 * day cost exactly as much as asking for seven. Tally stayed busy with it long
 * after the socket timed out, so the next request queued behind it and the one
 * after that, which reads from outside as the connector having died.
 *
 * `AllInventoryEntries.*` is gone for the same reason. The wildcard pulls every
 * inventory line of every voucher matched, which is a second unbounded walk
 * inside the first; the named fields below are what the sync engine reads.
 *
 * The filter compares against ##SVFROMDATE and ##SVTODATE rather than against
 * date literals of our own. Tally already holds those two as dates, so there is
 * no format to get wrong; writing `$$Date:"20260901"` instead would depend on
 * Tally reading a raw YYYYMMDD string, and a comparison it cannot parse does
 * not raise — it simply matches nothing. That is the same trap the receivables
 * filter fell into, and an empty day book is far too easy to read as a quiet
 * day rather than as a broken request.
 */
export function dayBook(company, fromDate, toDate) {
  const d = (x) =>
    `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
  const from = d(fromDate);
  const to = d(toDate);
  return exportRequest({
    id: 'BE Day Book',
    company,
    staticVars: { SVFROMDATE: from, SVTODATE: to },
    tdl: `     <COLLECTION NAME="BE Day Book" ISINITIALIZE="Yes">
      <TYPE>Voucher</TYPE>
      <FILTERS>BEInWindow</FILTERS>
${fetchList(['Guid', 'Date', 'VoucherTypeName', 'VoucherNumber', 'PartyLedgerName', 'Reference', 'Narration', 'Amount'])}
      <FETCH>AllInventoryEntries.StockItemName</FETCH>
      <FETCH>AllInventoryEntries.BilledQty</FETCH>
      <FETCH>AllInventoryEntries.Rate</FETCH>
      <FETCH>AllInventoryEntries.Amount</FETCH>
     </COLLECTION>
     <SYSTEM TYPE="Formulae" NAME="BEInWindow">$Date &gt;= ##SVFROMDATE AND $Date &lt;= ##SVTODATE</SYSTEM>`,
  });
}
