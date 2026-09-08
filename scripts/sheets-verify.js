/**
 * The claim, tested: the sheet is the store.
 *
 *   npm run sheets:verify
 *
 * Not a unit test of the mapping. It is the one sequence that has to work, run
 * against the real Apps Script (loaded into a fake Google — see
 * src/sheets/mock-server.js) and a throwaway database:
 *
 *   1. Records are created in the ERP.
 *   2. They are pushed to the sheet.
 *   3. The database is emptied, as `npm run db:reset` empties it.
 *   4. The sheet is pulled.
 *   5. Everything is back, byte for byte, with every id and every join intact.
 *
 * If step 5 fails, the sheet is a log rather than a store, and losing this
 * laptop loses the order book. That is the thing worth a test.
 *
 * It writes to data/sheets-test.db and never touches the working database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDb = path.join(root, 'data', 'sheets-test.db');
for (const f of [testDb, `${testDb}-wal`, `${testDb}-shm`]) fs.rmSync(f, { force: true });
process.env.DB_PATH = testDb;
process.env.SHEETS_PULL_ON_BOOT = 'false';
process.env.SHEETS_INTERVAL_MINUTES = '0';

const { db, seedUsers } = await import('../src/db/index.js');
seedUsers();
const { startMockSheet } = await import('../src/sheets/mock-server.js');
const store = await import('../src/sheets/store.js');
const { TABS } = await import('../src/sheets/tabs.js');

let n = 0, fails = 0;
const ok = (cond, label, extra = '') => {
  n++;
  if (!cond) { fails++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
  else console.log(`  ok    ${label}`);
};

const sheet = await startMockSheet({ port: 9200, token: 'verify-token' });
store.saveConnection({ webAppUrl: sheet.url, token: sheet.token, sheetId: '1suCLX3dVZfcM2KIXUXpwMIWZ4N9CiU74JiaQgvGv8sY' });

console.log('\n1. The connection answers');
const pong = await store.ping();
ok(pong.ok === true, 'ping', pong.spreadsheetName);
ok(store.target().configured, 'reported as configured');

// --- Records, made the way the app makes them -------------------------------
console.log('\n2. Numbering refuses to run before the sheet has been read');
let tooEarly = null;
try { (await import('../src/quotations/service.js')).nextQuoteNumber(); }
catch (err) { tooEarly = err.message; }
ok(tooEarly !== null && /has not been read/.test(tooEarly),
   'a quote number cannot be minted from a database that has not caught up', tooEarly || 'it minted one');

// What a boot does: read the sheet before serving anything. Here the sheet is
// empty, which is the genuine first-run case and must not be an error.
const firstPull = await store.pull({ trigger: 'boot' });
ok(firstPull.rows === 0, 'the first pull of an empty sheet reads nothing and does not fail');
ok(store.target().readyToMint, 'and numbering is released');

console.log('\n3. Records exist in the ERP');
const now = new Date().toISOString();
db.prepare(`INSERT INTO tally_ledgers (guid,name,is_customer,credit_limit,outstanding,synced_at) VALUES ('g-1','Sanghvi Industries Pvt Ltd',1,500000,120000,?)`).run(now);

const quotations = await import('../src/quotations/service.js');
const orders = await import('../src/orders/service.js');
const actor = { id: 1, name: 'Shubh Khandelwal' };

const quote = quotations.createQuotation({
  customerName: 'Sanghvi Industries Pvt Ltd',
  customerGuid: 'g-1',
  notes: 'Rates valid for the listed quantities only.',
  lines: [
    { itemName: 'Pneumatic Fitting 1/4" BSP', itemCode: 'PF-14-BSP', qty: 50, units: 'Nos', listRate: 120, discountPct: 10, gstRate: 18, brand: 'SMC' },
    { itemName: 'PU Tube 8mm', itemCode: 'PU-8', qty: 200, units: 'Mtr', listRate: 22, discountPct: 5, gstRate: 18, brand: 'Festo' },
  ],
}, actor);

const order = orders.createOrder({
  customerName: 'Sanghvi Industries Pvt Ltd',
  customerGuid: 'g-1',
  customerPoNumber: '4500123456',
  poDate: '2026-09-01',
  quotationId: quote.id,
  source: 'email',
  sourceRef: 'gmail-msg-1',
  documentUrl: 'https://drive.google.com/file/d/abc/view',
  lines: [
    { itemName: 'Pneumatic Fitting 1/4" BSP', itemCode: 'PF-14-BSP', qty: 50, units: 'Nos', rate: 108, gstRate: 18 },
    { itemName: 'PU Tube 8mm', itemCode: 'PU-8', qty: 200, units: 'Mtr', rate: 20.9, gstRate: 18 },
  ],
}, actor);

// Dispatch and invoice have no screens yet. Written directly, because the store
// has to carry them the day those screens land — not be extended then.
db.prepare(`INSERT INTO dispatches (order_id,dispatch_number,status,lr_number,transporter,lr_date,freight_amount,dispatched_at,created_by)
            VALUES (?,?,'dispatched','LR-7781','Rajdhani Roadlines','2026-09-04',850,?,1)`).run(order.id, 'BE/DN/2627/0001', now);
const dispatchId = db.prepare('SELECT id FROM dispatches ORDER BY id DESC LIMIT 1').get().id;
const orderLines = db.prepare('SELECT id, item_name, units FROM order_lines WHERE order_id = ? ORDER BY line_no').all(order.id);
for (const line of orderLines) {
  db.prepare(`INSERT INTO dispatch_lines (dispatch_id,order_line_id,item_name,qty_dispatched,units) VALUES (?,?,?,?,?)`)
    .run(dispatchId, line.id, line.item_name, 25, line.units);
}
db.prepare(`INSERT INTO invoices (order_id,dispatch_id,invoice_number,invoice_date,amount,tally_bill_ref) VALUES (?,?,?,?,?,?)`)
  .run(order.id, dispatchId, 'BE/26-27/0412', '2026-09-04', 6832.5, 'BE/26-27/0412');
store.queueDispatch(dispatchId);
store.queue('invoices', db.prepare('SELECT id FROM invoices ORDER BY id DESC LIMIT 1').get().id);
for (const e of db.prepare('SELECT id FROM pipeline_events').all()) store.queue('pipeline_events', e.id);

const before = snapshot();
ok(before.quotations.length === 1, 'a quotation');
ok(before.quotation_lines.length === 2, 'two quotation lines');
ok(before.orders.length === 1, 'an order');
ok(before.order_lines.length === 2, 'two order lines');
ok(before.dispatches.length === 1, 'a dispatch');
ok(before.invoices.length === 1, 'an invoice');
ok(before.pipeline_events.length > 0, 'pipeline events', String(before.pipeline_events.length));

// --- Push -------------------------------------------------------------------
console.log('\n4. The push reaches the sheet');
ok(store.pendingCount() > 0, 'writes were queued as they happened', String(store.pendingCount()));
const pushed = await store.drain();
ok(store.pendingCount() === 0, 'the queue emptied');
ok(pushed.rows > 0, 'rows went out', String(pushed.rows));
ok(sheet.tab('Orders') !== null, 'an Orders tab was created');
ok(sheet.tab('Orders').getLastRow() === 2, 'one order row under one header row', String(sheet.tab('Orders')?.getLastRow()));
ok(sheet.tab('Order Lines').getLastRow() === 3, 'two order-line rows');

console.log('\n5. The sheet reads as a person would want it to');
const header = sheet.tab('Orders').getDataRange().getValues()[0];
const row = sheet.tab('Orders').getDataRange().getValues()[1];
const cell = (name) => row[header.indexOf(name)];
ok(cell('Order Number') === order.order_number, 'the order number is intact', String(cell('Order Number')));
ok(String(cell('Customer PO')) === '4500123456', 'the PO number survived as typed', String(cell('Customer PO')));
ok(cell('Customer') === 'Sanghvi Industries Pvt Ltd', 'the customer is named');
const lineHeader = sheet.tab('Order Lines').getDataRange().getValues()[0];
const lineRow = sheet.tab('Order Lines').getDataRange().getValues()[1];
ok(lineRow[lineHeader.indexOf('Order Number')] === order.order_number,
   'a line says which order it belongs to, without a lookup');

// --- The whole point --------------------------------------------------------
console.log('\n6. The database is destroyed');
const wipe = db.transaction(() => {
  db.pragma('foreign_keys = OFF');
  for (const spec of [...TABS].reverse()) db.prepare(`DELETE FROM ${spec.table}`).run();
  db.pragma('foreign_keys = ON');
});
wipe();
ok(count('orders') === 0, 'nothing is left');
ok(count('order_lines') === 0, 'no lines are left');

console.log('\n7. The sheet puts it back');
const pulled = await store.pull({ trigger: 'manual' });
ok(pulled.problems.length === 0, 'no unusable rows', pulled.problems.join('; '));
const after = snapshot();
for (const spec of TABS) {
  ok(
    JSON.stringify(after[spec.key]) === JSON.stringify(before[spec.key]),
    `${spec.label} came back identical`,
    after[spec.key].length !== before[spec.key].length
      ? `${before[spec.key].length} out, ${after[spec.key].length} back`
      : firstDifference(before[spec.key], after[spec.key])
  );
}

console.log('\n8. The joins survived, which is what the ids were for');
const restored = db.prepare('SELECT * FROM orders').get();
ok(restored.id === order.id, 'the order kept its id');
ok(db.prepare('SELECT COUNT(*) AS n FROM order_lines WHERE order_id = ?').get(restored.id).n === 2,
   'its lines still point at it');
ok(db.prepare('SELECT COUNT(*) AS n FROM dispatch_lines dl JOIN order_lines ol ON ol.id = dl.order_line_id').get().n === 2,
   'dispatch lines still point at order lines');
ok(db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE order_id = ?').get(restored.id).n === 1,
   'the invoice still points at the order');

console.log('\n9. Numbering does not restart from one');
ok(orders.nextOrderNumber() !== restored.order_number,
   'the next order number is not the one already issued', orders.nextOrderNumber());
ok(quotations.nextQuoteNumber() !== db.prepare('SELECT quote_number FROM quotations').get().quote_number,
   'the next quote number is not the one already issued', quotations.nextQuoteNumber());

console.log('\n10. Deleting a line in the ERP deletes it in the sheet');
db.prepare('DELETE FROM order_lines WHERE order_id = ? AND line_no = 2').run(restored.id);
store.queueOrder(restored.id);
await store.drain();
ok(sheet.tab('Order Lines').getLastRow() === 2, 'the sheet is down to one line', String(sheet.tab('Order Lines').getLastRow()));
await store.pull({ trigger: 'manual' });
ok(count('order_lines') === 1, 'and a pull does not resurrect it', String(count('order_lines')));

console.log('\n11. A discarded pick list is removed from the sheet, not just from here');
const dispatchSvc = await import('../src/dispatch/service.js');
const scratch = dispatchSvc.createDispatch(restored.id, actor);
await store.drain();
ok(sheet.tab('Dispatches').getLastRow() === 3, 'the new pick list reached the sheet',
   String(sheet.tab('Dispatches').getLastRow()));
dispatchSvc.abandon(scratch.id, actor);
await store.drain();
ok(sheet.tab('Dispatches').getLastRow() === 2, 'and discarding it took the row back out',
   String(sheet.tab('Dispatches').getLastRow()));
await store.pull({ trigger: 'manual' });
// The failure this guards against: a delete that only happened locally. The
// next pull would read the abandoned pick list straight back in, and it would
// go on holding stock that nobody is picking.
ok(!db.prepare('SELECT 1 FROM dispatches WHERE id = ?').get(scratch.id),
   'and a pull does not bring it back');
ok(!db.prepare('SELECT 1 FROM dispatch_lines WHERE dispatch_id = ?').get(scratch.id),
   'nor its lines');

console.log('\n12. The mail sweep’s tabs are refused');
let refused = null;
try {
  const { call } = await import('../src/sheets/client.js');
  await call('batch', { writes: [{ tab: 'Order Log', header: ['ID'], types: ['int'], key: 'ID', rows: [[1]] }] });
} catch (err) { refused = err.message; }
ok(refused !== null && /mail sweep/.test(refused), 'writing Order Log is refused', refused || 'it was allowed');

console.log('\n13. A bad token is refused');
let badToken = null;
try {
  await store.ping({ webAppUrl: sheet.url, token: 'not-the-token' });
} catch (err) { badToken = err.message; }
ok(badToken !== null && /token/i.test(badToken), 'a wrong token gets nowhere', badToken || 'it was allowed');

await sheet.stop();
console.log(`\n${n - fails}/${n} passed${fails ? `, ${fails} FAILED` : ''}\n`);
process.exit(fails ? 1 : 0);

// --- helpers ----------------------------------------------------------------
function count(table) { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; }
function snapshot() {
  const out = {};
  for (const spec of TABS) out[spec.key] = db.prepare(`SELECT * FROM ${spec.table} ORDER BY id`).all();
  return out;
}
function firstDifference(a, b) {
  for (let i = 0; i < a.length; i++) {
    for (const k of Object.keys(a[i])) {
      if (JSON.stringify(a[i][k]) !== JSON.stringify(b[i]?.[k])) {
        return `row ${i + 1} ${k}: ${JSON.stringify(a[i][k])} -> ${JSON.stringify(b[i]?.[k])}`;
      }
    }
  }
  return '';
}
