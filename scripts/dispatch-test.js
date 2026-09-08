/**
 * Picking and dispatch, checked against a throwaway database.
 *
 *   npm run dispatch:test
 *
 * The failures worth guarding against here do not throw. A lorry leaves with
 * stock that was already promised to another pick list; an order sits at
 * "dispatched" while 50 metres of it are still on the rack; a quantity is
 * quietly edited a week after delivery and the short-shipment argument becomes
 * unwinnable. None of those crash anything, so each one is asserted directly.
 *
 * It writes to data/dispatch-test.db and never touches the working database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDb = path.join(root, 'data', 'dispatch-test.db');
for (const f of [testDb, `${testDb}-wal`, `${testDb}-shm`]) fs.rmSync(f, { force: true });
process.env.DB_PATH = testDb;

const { db, seedUsers } = await import('../src/db/index.js');
seedUsers();
const orders = await import('../src/orders/service.js');
const dispatch = await import('../src/dispatch/service.js');

let n = 0, fails = 0;
const ok = (cond, label, extra = '') => {
  n++;
  if (!cond) { fails++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`); }
  else console.log(`  ok    ${label}`);
};
const throws = (fn, match, label) => {
  let message = null;
  try { fn(); } catch (e) { message = e.message; }
  ok(message !== null && match.test(message), label, message === null ? 'it was allowed' : message);
  return message;
};

const actor = { id: 1, name: 'Shubh Khandelwal' };
const now = new Date().toISOString();
db.prepare(`INSERT INTO tally_ledgers (guid,name,is_customer,credit_limit,outstanding,synced_at)
            VALUES ('g-1','Sanghvi Industries Pvt Ltd',1,500000,120000,?)`).run(now);

const makeOrder = (po, lines) => orders.createOrder({
  customerName: 'Sanghvi Industries Pvt Ltd', customerGuid: 'g-1',
  customerPoNumber: po, lines, allowDuplicate: true,
}, actor);

const order = makeOrder('4500100001', [
  { itemName: 'PU Tube 8mm', itemCode: 'PU-8', qty: 200, units: 'Mtr', rate: 20.9, gstRate: 18 },
  { itemName: 'Pneumatic Fitting 1/4 BSP', itemCode: 'PF-14', qty: 50, units: 'Nos', rate: 108, gstRate: 18 },
]);

console.log('\n1. A pick list starts from what is outstanding');
let d1 = dispatch.createDispatch(order.id, actor);
ok(/^BE\/DN\//.test(d1.dispatch_number), 'it gets a BE/DN number', d1.dispatch_number);
ok(d1.status === 'picking', 'it starts at picking');
ok(d1.lines.length === 2, 'both lines are on it');
ok(d1.lines[0].qty_dispatched === 200 && d1.lines[1].qty_dispatched === 50,
   'prefilled with the full outstanding quantity');
ok(orders.getOrder(order.id).status === 'open', 'the order is still open — nothing has moved');

console.log('\n2. A second pick list cannot claim the same stock');
throws(() => dispatch.createDispatch(order.id, actor), /already on a pick list/,
  'a second pick list on a fully-claimed order is refused');

console.log('\n3. A short pick is ordinary, and is recorded as it happens');
d1 = dispatch.updateDispatch(d1.id, {
  lines: [
    { orderLineId: d1.lines[0].order_line_id, qty: 150, notes: 'only 150 on the rack' },
    { orderLineId: d1.lines[1].order_line_id, qty: 50 },
  ],
  transporter: 'Rajdhani Roadlines',
}, actor);
ok(d1.lines[0].qty_dispatched === 150, 'the short quantity is what is stored', String(d1.lines[0].qty_dispatched));
ok(d1.totals.units === 200, 'the totals follow', String(d1.totals.units));

console.log('\n4. It has to be packed before it can be dispatched');
throws(() => dispatch.setStatus(d1.id, 'delivered', actor), /has to be marked packed first/,
  'picking cannot jump to delivered');
d1 = dispatch.setStatus(d1.id, 'packed', actor);
ok(d1.status === 'packed' && d1.packed_at, 'packed, and the time is stamped');
ok(orders.getOrder(order.id).status === 'open', 'packed is still here — the order has not moved');

console.log('\n5. Unpacking to change it is allowed; un-sending is not');
d1 = dispatch.setStatus(d1.id, 'picking', actor);
ok(d1.status === 'picking', 'packed can go back to picking');
d1 = dispatch.setStatus(d1.id, 'packed', actor);
d1 = dispatch.setStatus(d1.id, 'dispatched', actor);
ok(d1.status === 'dispatched' && d1.dispatched_at, 'dispatched, and the time is stamped');
throws(() => dispatch.setStatus(d1.id, 'packed', actor), /cannot be undone/,
  'a dispatch cannot be un-sent');

console.log('\n6. The order works out its own status');
ok(orders.getOrder(order.id).status === 'part_dispatched',
   'part dispatched, without anyone saying so', orders.getOrder(order.id).status);

console.log('\n7. What went cannot be edited afterwards');
throws(() => dispatch.updateDispatch(d1.id, { lines: [{ orderLineId: d1.lines[0].order_line_id, qty: 200 }] }, actor),
  /already gone/, 'quantities are frozen once it has left');

console.log('\n8. The LR can arrive later, and the queue says so');
ok(dispatch.getDispatch(d1.id).awaitingLr === true, 'it is flagged as gone without an LR');
ok(dispatch.dispatchSummary().awaitingLr === 1, 'and it is in the awaiting-LR count');
d1 = dispatch.updateDispatch(d1.id, { lrNumber: 'LR-7781', lrDate: '2026-09-08', freightAmount: 850 }, actor);
ok(d1.lr_number === 'LR-7781' && d1.awaitingLr === false, 'adding the LR clears the flag');
ok(dispatch.dispatchSummary().awaitingLr === 0, 'and empties the queue');
ok(d1.events.some((e) => /LR-7781/.test(e.note || '')), 'when the LR arrived is on the record');

console.log('\n9. The balance is still pending, and can be sent');
const pending = dispatch.pendingLines(order.id);
ok(pending[0].qty_gone === 150, '150 has gone', String(pending[0].qty_gone));
ok(pending[0].qty_pending === 50, '50 is still outstanding', String(pending[0].qty_pending));
ok(pending[1].qty_pending === 0, 'the fully-sent line has nothing outstanding');

let d2 = dispatch.createDispatch(order.id, actor);
ok(d2.lines.length === 1, 'the second pick list carries only the shortfall');
ok(d2.lines[0].qty_dispatched === 50, 'and only the outstanding quantity', String(d2.lines[0].qty_dispatched));

console.log('\n10. Over-picking is refused, not warned about');
throws(() => dispatch.updateDispatch(d2.id, { lines: [{ orderLineId: d2.lines[0].order_line_id, qty: 80 }] }, actor),
  /more than the 50 still outstanding/, 'sending more than was ordered is refused');

console.log('\n11. A substitution is recorded against the line it answers');
d2 = dispatch.updateDispatch(d2.id, {
  lines: [{ orderLineId: d2.lines[0].order_line_id, qty: 50, substitutedWith: 'PU Tube 8mm (Festo)', notes: 'SMC out of stock' }],
}, actor);
ok(d2.lines[0].substituted_with === 'PU Tube 8mm (Festo)', 'what actually went is named');
ok(d2.lines[0].order_line_id === pending[0].id, 'while still answering the ordered line');

d2 = dispatch.setStatus(d2.id, 'packed', actor);
d2 = dispatch.setStatus(d2.id, 'dispatched', actor);
ok(orders.getOrder(order.id).status === 'dispatched', 'the order is now fully dispatched',
   orders.getOrder(order.id).status);
ok(dispatch.readyToPick().every((o) => o.id !== order.id), 'and it has left the pick queue');

console.log('\n12. Delivery and the POD');
d2 = dispatch.setStatus(d2.id, 'delivered', actor);
ok(d2.delivered_at !== null, 'delivery is stamped');
ok(dispatch.dispatchSummary().awaitingPod === 1, 'it is waiting on a POD');
d2 = dispatch.setPod(d2.id, true, actor);
ok(d2.pod_received === 1 && dispatch.dispatchSummary().awaitingPod === 0, 'and the POD clears it');

console.log('\n13. Two open pick lists never promise the same stock twice');
const order2 = makeOrder('4500100002', [
  { itemName: 'Emery Paper P80', itemCode: 'EP-80', qty: 100, units: 'Nos', rate: 12, gstRate: 18 },
]);
const a = dispatch.createDispatch(order2.id, actor);
dispatch.updateDispatch(a.id, { lines: [{ orderLineId: a.lines[0].order_line_id, qty: 40 }] }, actor);
const b = dispatch.createDispatch(order2.id, actor);
ok(b.lines[0].qty_dispatched === 60, 'the second list is offered only the unclaimed 60',
   String(b.lines[0].qty_dispatched));
throws(() => dispatch.updateDispatch(b.id, { lines: [{ orderLineId: b.lines[0].order_line_id, qty: 100 }] }, actor),
  /on another open pick list/, 'and taking all 100 is refused, naming why');

console.log('\n14. Discarding a pick list gives the stock back');
const before = dispatch.pendingLines(order2.id)[0].qty_pending;
dispatch.abandon(a.id, actor);
const after = dispatch.pendingLines(order2.id)[0].qty_pending;
ok(after === before + 40, 'the 40 it was holding is available again', `${before} -> ${after}`);
throws(() => dispatch.abandon(d1.id, actor), /cannot be discarded/, 'a dispatch that has gone cannot be discarded');

console.log('\n15. Orders that cannot be picked');
const cancelled = makeOrder('4500100003', [{ itemName: 'X', qty: 1, units: 'Nos', rate: 1, gstRate: 18 }]);
orders.cancelOrder(cancelled.id, 'customer withdrew', actor);
throws(() => dispatch.createDispatch(cancelled.id, actor), /is cancelled/, 'a cancelled order cannot be picked');

const headerOnly = orders.createOrder({
  customerName: 'Sanghvi Industries Pvt Ltd', customerGuid: 'g-1',
  customerPoNumber: '4500100004', lines: [], source: 'email', sourceRef: 'gmail:x1', allowDuplicate: true,
}, actor);
throws(() => dispatch.createDispatch(headerOnly.id, actor), /no items entered/,
  'a PO whose items are still in the PDF says so, rather than raising an empty pick list');

console.log('\n16. Numbering');
const numbers = db.prepare('SELECT dispatch_number FROM dispatches ORDER BY id').all().map((r) => r.dispatch_number);
ok(new Set(numbers).size === numbers.length, 'no two dispatches share a number', numbers.join(', '));
ok(/BE\/DN\/\d{4}\/0001$/.test(numbers[0]), 'the first is 0001', numbers[0]);

console.log(`\n${n - fails}/${n} passed${fails ? `, ${fails} FAILED` : ''}\n`);
process.exit(fails ? 1 : 0);
