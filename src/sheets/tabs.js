/**
 * What lives in the sheet, and under which column.
 *
 * One declaration per mirrored table, used in both directions: to build the
 * rows pushed up, and to read rows back down into SQLite. Having a single
 * declaration is the point — a push and a pull that each carry their own idea
 * of the column order agree right up until someone inserts a column, and then
 * disagree silently, which in a spreadsheet means a customer name landing in
 * the GST column.
 *
 * COLUMN ONE IS ALWAYS `ID`, AND IT IS NOT DECORATION.
 * It is the SQLite row id, written out and read back verbatim, which is what
 * makes a rebuilt database identical to the one it replaced rather than merely
 * similar: order lines still point at the same order, events still point at the
 * same entity. A human editing the sheet may change anything else. Changing an
 * id, or deleting the column, breaks the join — so the puller refuses a row
 * with no usable id rather than inventing one.
 *
 * Declared in dependency order. The pull walks this list start to end and the
 * push walks it the same way, so a parent always exists before its children
 * arrive and foreign keys never have to be switched off.
 */

/** `type` decides both the sheet's number format and the coercion on the way back. */
const TEXT = 'text';
const INT = 'int';
const REAL = 'real';
const BOOL = 'bool';

/**
 * Children are wiped and rewritten per parent rather than merged.
 *
 * A quotation's lines are not independent records that happen to share a
 * parent; they are the quotation's contents. Deleting line 3 of five has to
 * mean the quotation now has four lines, and an upsert-only pull would leave
 * the deleted line sitting there for ever.
 */
const child = (parentColumn) => ({ parent: parentColumn });

export const TABS = [
  {
    key: 'quotations',
    tab: 'Quotations',
    table: 'quotations',
    label: 'Quotations',
    columns: [
      ['ID', 'id', INT],
      ['Quote Number', 'quote_number', TEXT],
      ['Version', 'version', INT],
      ['Current', 'is_current', BOOL],
      ['Status', 'status', TEXT],
      ['Customer', 'customer_name', TEXT],
      ['Customer GUID', 'customer_guid', TEXT],
      ['Quote Date', 'quote_date', TEXT],
      ['Valid Until', 'valid_until', TEXT],
      ['Sent At', 'sent_at', TEXT],
      ['Lost Reason', 'lost_reason', TEXT],
      ['Subtotal', 'subtotal', REAL],
      ['Tax', 'tax_amount', REAL],
      ['Total', 'total', REAL],
      ['Notes', 'notes', TEXT],
      ['Source', 'source', TEXT],
      ['Source Ref', 'source_ref', TEXT],
      ['Document URL', 'document_url', TEXT],
      ['RFQ ID', 'rfq_id', INT],
      ['Created By', 'created_by', INT],
      ['Created At', 'created_at', TEXT],
      ['Updated At', 'updated_at', TEXT],
    ],
  },
  {
    key: 'quotation_lines',
    tab: 'Quotation Lines',
    table: 'quotation_lines',
    label: 'Quotation lines',
    ...child('quotation_id'),
    columns: [
      ['ID', 'id', INT],
      ['Quotation ID', 'quotation_id', INT],
      // Denormalised so a human reading the tab can tell which quotation a
      // line belongs to without a VLOOKUP. Never read back — the ID is the join.
      ['Quote Number', null, TEXT, (row, ctx) => ctx.quotations?.get(row.quotation_id)?.quote_number || ''],
      ['Line', 'line_no', INT],
      ['Item', 'item_name', TEXT],
      ['Item Code', 'item_code', TEXT],
      ['Item GUID', 'item_guid', TEXT],
      ['Brand', 'brand', TEXT],
      ['HSN', 'hsn', TEXT],
      ['Qty', 'qty', REAL],
      ['Units', 'units', TEXT],
      ['List Rate', 'list_rate', REAL],
      ['Discount %', 'discount_pct', REAL],
      ['Rate', 'rate', REAL],
      ['GST %', 'gst_rate', REAL],
      ['Amount', 'amount', REAL],
      ['Remarks', 'remarks', TEXT],
    ],
  },
  {
    key: 'orders',
    tab: 'Orders',
    table: 'orders',
    label: 'Orders',
    columns: [
      ['ID', 'id', INT],
      ['Order Number', 'order_number', TEXT],
      ['Status', 'status', TEXT],
      ['Customer', 'customer_name', TEXT],
      ['Customer GUID', 'customer_guid', TEXT],
      ['Customer PO', 'customer_po_number', TEXT],
      ['PO Date', 'po_date', TEXT],
      ['Received At', 'received_at', TEXT],
      ['Quotation ID', 'quotation_id', INT],
      ['Payment Terms (days)', 'payment_terms_days', INT],
      ['Subtotal', 'subtotal', REAL],
      ['Tax', 'tax_amount', REAL],
      ['Total', 'total', REAL],
      // A snapshot of what credit looked like when the PO was recorded. It is
      // mirrored because it is a judgement made at a moment, not a figure that
      // can be recomputed later from Tally's current balances.
      ['Credit Status', 'credit_status', TEXT],
      ['Credit Limit At Order', 'credit_limit_at_order', REAL],
      ['Outstanding At Order', 'outstanding_at_order', REAL],
      ['Overdue At Order', 'overdue_at_order', REAL],
      ['Credit Note', 'credit_note', TEXT],
      ['Source', 'source', TEXT],
      ['Source Ref', 'source_ref', TEXT],
      ['Document URL', 'document_url', TEXT],
      ['Cancelled Reason', 'cancelled_reason', TEXT],
      ['Notes', 'notes', TEXT],
      ['Created By', 'created_by', INT],
      ['Created At', 'created_at', TEXT],
      ['Updated At', 'updated_at', TEXT],
    ],
  },
  {
    key: 'order_lines',
    tab: 'Order Lines',
    table: 'order_lines',
    label: 'Order lines',
    ...child('order_id'),
    columns: [
      ['ID', 'id', INT],
      ['Order ID', 'order_id', INT],
      ['Order Number', null, TEXT, (row, ctx) => ctx.orders?.get(row.order_id)?.order_number || ''],
      ['Line', 'line_no', INT],
      ['Item', 'item_name', TEXT],
      ['Item Code', 'item_code', TEXT],
      ['Item GUID', 'item_guid', TEXT],
      ['Brand', 'brand', TEXT],
      ['HSN', 'hsn', TEXT],
      ['Qty Ordered', 'qty_ordered', REAL],
      ['Units', 'units', TEXT],
      ['Rate', 'rate', REAL],
      ['GST %', 'gst_rate', REAL],
      ['Amount', 'amount', REAL],
      ['Notes', 'notes', TEXT],
    ],
  },
  {
    key: 'dispatches',
    tab: 'Dispatches',
    table: 'dispatches',
    label: 'Dispatches',
    columns: [
      ['ID', 'id', INT],
      ['Dispatch Number', 'dispatch_number', TEXT],
      ['Order ID', 'order_id', INT],
      ['Order Number', null, TEXT, (row, ctx) => ctx.orders?.get(row.order_id)?.order_number || ''],
      ['Status', 'status', TEXT],
      ['LR Number', 'lr_number', TEXT],
      ['Transporter', 'transporter', TEXT],
      ['LR Date', 'lr_date', TEXT],
      ['Freight', 'freight_amount', REAL],
      ['Packed At', 'packed_at', TEXT],
      ['Dispatched At', 'dispatched_at', TEXT],
      ['Delivered At', 'delivered_at', TEXT],
      ['POD Received', 'pod_received', BOOL],
      ['Notes', 'notes', TEXT],
      ['Created By', 'created_by', INT],
      ['Created At', 'created_at', TEXT],
      ['Updated At', 'updated_at', TEXT],
    ],
  },
  {
    key: 'dispatch_lines',
    tab: 'Dispatch Lines',
    table: 'dispatch_lines',
    label: 'Dispatch lines',
    ...child('dispatch_id'),
    columns: [
      ['ID', 'id', INT],
      ['Dispatch ID', 'dispatch_id', INT],
      ['Order Line ID', 'order_line_id', INT],
      ['Item', 'item_name', TEXT],
      ['Qty Dispatched', 'qty_dispatched', REAL],
      ['Units', 'units', TEXT],
      ['Substituted With', 'substituted_with', TEXT],
      ['Notes', 'notes', TEXT],
    ],
  },
  {
    key: 'invoices',
    tab: 'Invoices',
    table: 'invoices',
    label: 'Invoices',
    columns: [
      ['ID', 'id', INT],
      ['Invoice Number', 'invoice_number', TEXT],
      ['Order ID', 'order_id', INT],
      ['Order Number', null, TEXT, (row, ctx) => ctx.orders?.get(row.order_id)?.order_number || ''],
      ['Dispatch ID', 'dispatch_id', INT],
      ['Invoice Date', 'invoice_date', TEXT],
      ['Amount', 'amount', REAL],
      // The link to Tally, not a copy of it. Whether the bill is paid is asked
      // of Tally at read time; an empty cell here is an unmatched invoice,
      // which is a data-quality signal worth seeing in the sheet.
      ['Tally Bill Ref', 'tally_bill_ref', TEXT],
      ['Matched At', 'matched_at', TEXT],
      ['Created At', 'created_at', TEXT],
    ],
  },
  {
    key: 'pipeline_events',
    tab: 'Pipeline Events',
    table: 'pipeline_events',
    label: 'Pipeline events',
    /**
     * Append-only, and never re-pushed once written.
     *
     * An event is a statement that something happened at a time. Editing one
     * later is not a correction, it is a falsification of the audit trail, so
     * the mirror only ever adds rows here.
     */
    appendOnly: true,
    columns: [
      ['ID', 'id', INT],
      ['At', 'at', TEXT],
      ['Entity', 'entity_type', TEXT],
      ['Entity ID', 'entity_id', INT],
      ['Order ID', 'order_id', INT],
      ['From', 'from_stage', TEXT],
      ['To', 'to_stage', TEXT],
      ['Note', 'note', TEXT],
      ['Actor', 'actor_name', TEXT],
      ['Actor ID', 'actor_id', INT],
    ],
  },
];

export const TAB_BY_KEY = new Map(TABS.map((t) => [t.key, t]));

/**
 * Tabs the sweep script owns. Listed so the connection screen can show them
 * and, more importantly, so the ERP never writes to them: the mail log is the
 * script's record of what it pushed, and an ERP rewriting it would destroy the
 * only thing the two can be reconciled against.
 */
export const SCRIPT_TABS = ['Order Log', 'Inquiry Log', 'Needs Review'];

/** Header row for a tab, in column order. */
export const headerOf = (spec) => spec.columns.map((c) => c[0]);

/** Column types, sent with every write so the script can format the tab once. */
export const typesOf = (spec) => spec.columns.map((c) => c[2]);

/** Turn a SQLite row into a sheet row. `ctx` carries the lookups for derived columns. */
export function toRow(spec, row, ctx = {}) {
  return spec.columns.map(([, column, type, derive]) => {
    if (derive) return derive(row, ctx);
    const v = row[column];
    if (v === null || v === undefined) return '';
    if (type === BOOL) return v ? 'yes' : 'no';
    if (type === INT || type === REAL) return Number(v);
    return String(v);
  });
}

/**
 * Turn a sheet row back into column values.
 *
 * Deliberately forgiving about what a cell holds and strict about what it
 * means. Sheets hands back a number for `4500123456` whether or not it was
 * typed as text, a Date for anything it decided was a date, and an empty
 * string for a cell someone cleared. None of that is worth failing over. A
 * missing or non-numeric id is: that row cannot be joined to anything.
 */
export function fromRow(spec, header, cells) {
  const index = new Map(header.map((h, i) => [String(h).trim(), i]));
  const out = {};
  for (const [name, column, type] of spec.columns) {
    if (!column) continue;                       // derived, for humans only
    const at = index.get(name);
    const raw = at === undefined ? undefined : cells[at];
    out[column] = coerce(raw, type);
  }
  return out;
}

function coerce(raw, type) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (type === BOOL) {
    if (typeof raw === 'boolean') return raw ? 1 : 0;
    return ['yes', 'true', '1', 'y'].includes(String(raw).trim().toLowerCase()) ? 1 : 0;
  }
  if (type === INT || type === REAL) {
    const n = Number(String(raw).replace(/,/g, '').trim());
    if (!Number.isFinite(n)) return null;
    return type === INT ? Math.trunc(n) : n;
  }
  // Sheets returns a Date for anything it read as one. Everything downstream
  // stores dates as ISO text, so normalise here rather than in six callers.
  if (raw instanceof Date) return raw.toISOString();
  return String(raw).trim();
}
