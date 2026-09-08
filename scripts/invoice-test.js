/**
 * Invoicing and the payment clock, against a throwaway database.
 *
 *   npm run invoice:test
 *
 * The dangerous failures here are all quiet ones. An invoice linked to a
 * same-numbered bill belonging to a different customer produces a payment
 * chase addressed to the wrong company. A bill that has been settled and has
 * therefore vanished from Tally's receivables gets reported as "missing" and
 * someone re-raises it. A locally-cached "paid" flag says paid three weeks
 * after the money actually arrived. None of those throw, so each is asserted.
 *
 * It writes to data/invoice-test.db and never touches the working database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDb = path.join(root, 'data', 'invoice-test.db');
for (const f of [testDb, `${testDb}-wal`, `${testDb}-shm`]) fs.rmSync(f, { force: true });
process.env.DB_PATH = testDb;

const { db, seedUsers } = await import('../src/db/index.js');
seedUsers();
const orders = await import('../src/orders/service.js');
const dispatch = await import('../src/dispatch/service.js');
const invoices = await import('../src/invoices/service.js');

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
};

const actor = { id: 1, name: 'Shubh Khandelwal' };
const now = new Date().toISOString();
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

for (const [guid, name] of [['g-1', 'Sanghvi Industries Pvt Ltd'], ['g-2', 'Ashok Auto Works']]) {
  db.prepare(`INSERT INTO tally_ledgers (guid,name,is_customer,credit_limit,outstanding,credit_period_days,synced_at)
              VALUES (?,?,1,500000,120000,30,?)`).run(guid, name, now);
}

/** A bill as the Tally sync writes one: `amount` is what is STILL outstanding. */
const bill = (ref, party, { billDate, dueDate, opening, outstanding }) =>
  db.prepare(`INSERT INTO tally_bills (bill_ref,party_name,bill_date,due_date,credit_period_days,opening_amount,amount,synced_at)
              VALUES (?,?,?,?,30,?,?,?)`).run(ref, party, billDate, dueDate, opening, outstanding, now);

const shipItAll = (order) => {
  const d = dispatch.createDispatch(order.id, actor);
  dispatch.setStatus(d.id, 'packed', actor);
  return dispatch.setStatus(d.id, 'dispatched', actor);
};
const makeOrder = (po, customer = 'Sanghvi Industries Pvt Ltd') => orders.createOrder({
  customerName: customer, customerGuid: customer === 'Ashok Auto Works' ? 'g-2' : 'g-1',
  customerPoNumber: po, allowDuplicate: true,
  lines: [{ itemName: 'PU Tube 8mm', qty: 100, units: 'Mtr', rate: 100, gstRate: 18 }],
}, actor);

console.log('\n1. A dispatch that has gone is waiting to be invoiced');
const order1 = makeOrder('4500200001');
const d1 = shipItAll(order1);
let waiting = invoices.awaitingInvoice();
ok(waiting.length === 1 && waiting[0].dispatch_number === d1.dispatch_number,
   'it appears in the awaiting-invoice queue');
ok(Math.round(waiting[0].value.total) === 11800, 'valued at the order rates plus GST',
   String(waiting[0].value.total));

console.log('\n2. A pick list cannot be invoiced');
const order2 = makeOrder('4500200002');
const picking = dispatch.createDispatch(order2.id, actor);
throws(() => invoices.raiseInvoice({ dispatchId: picking.id, invoiceNumber: 'BE/2627/9999' }, actor),
  /has not gone out yet/, 'goods still on the rack cannot carry a tax invoice');

console.log('\n3. The invoice number is typed in, not issued here');
throws(() => invoices.raiseInvoice({ dispatchId: d1.id, invoiceNumber: '  ' }, actor),
  /invoice number is required/, 'a blank number is refused, and says whose number it is');

console.log('\n4. Raised, and matched against the bill Tally already has');
bill('BE/2627/0001', 'Sanghvi Industries Pvt Ltd', {
  billDate: iso(10), dueDate: iso(-20), opening: 11800, outstanding: 11800,
});
let inv1 = invoices.raiseInvoice({ dispatchId: d1.id, invoiceNumber: 'BE/2627/0001', invoiceDate: iso(10) }, actor);
ok(inv1.tally_bill_ref === 'BE/2627/0001', 'it found the bill on its own', String(inv1.tally_bill_ref));
ok(inv1.position.status === 'outstanding', 'within terms', inv1.position.label);
ok(inv1.position.outstanding === 11800, 'the outstanding figure comes from Tally');
ok(invoices.awaitingInvoice().length === 0, 'and it has left the awaiting-invoice queue');

console.log('\n5. The same dispatch cannot be invoiced twice');
throws(() => invoices.raiseInvoice({ dispatchId: d1.id, invoiceNumber: 'BE/2627/0002' }, actor),
  /already been invoiced/, 'a second invoice against one consignment is refused');

console.log('\n6. Overdue is Tally’s answer, not a stored flag');
const order3 = makeOrder('4500200003');
const d3 = shipItAll(order3);
bill('BE/2627/0003', 'Sanghvi Industries Pvt Ltd', {
  billDate: iso(75), dueDate: iso(45), opening: 11800, outstanding: 11800,
});
let inv3 = invoices.raiseInvoice({ dispatchId: d3.id, invoiceNumber: 'BE/2627/0003', invoiceDate: iso(75) }, actor);
ok(inv3.position.status === 'overdue', 'reported overdue', inv3.position.label);
ok(inv3.position.daysOverdue === 45, '45 days past due', String(inv3.position.daysOverdue));

console.log('\n7. A part payment in Tally shows up without anything being told');
db.prepare(`UPDATE tally_bills SET amount = 4800 WHERE bill_ref = 'BE/2627/0003'`).run();
inv3 = invoices.getInvoice(inv3.id);
ok(inv3.position.partPaid === true, 'part paid');
ok(inv3.position.paid === 7000, '₹7,000 of it has come in', String(inv3.position.paid));
ok(inv3.position.outstanding === 4800, '₹4,800 still to come', String(inv3.position.outstanding));
ok(inv3.position.status === 'overdue', 'and it is still overdue on the balance');

console.log('\n8. A bill settled in full disappears from Tally — that means PAID, not missing');
db.prepare(`DELETE FROM tally_bills WHERE bill_ref = 'BE/2627/0003'`).run();
inv3 = invoices.getInvoice(inv3.id);
ok(inv3.position.status === 'paid', 'read as paid, because it was matched once and the bill is now gone',
   inv3.position.status);
ok(invoices.invoiceSummary().unmatched === 0, 'it is NOT counted as unmatched');

console.log('\n9. An invoice with no bill behind it sits in a queue saying so');
const order4 = makeOrder('4500200004');
const d4 = shipItAll(order4);
let inv4 = invoices.raiseInvoice({ dispatchId: d4.id, invoiceNumber: 'BE/2627/0404' }, actor);
ok(inv4.position.status === 'unmatched', 'unmatched, not guessed at', inv4.position.label);
ok(invoices.invoiceSummary().unmatched === 1, 'and it is counted');

console.log('\n10. The same number against a DIFFERENT customer is never linked by a rule');
bill('BE/2627/0404', 'Ashok Auto Works', {
  billDate: iso(5), dueDate: iso(-25), opening: 11800, outstanding: 11800,
});
const result = invoices.matchInvoice(inv4.id, { actor });
ok(result.matched === false, 'the reference matches but the party does not, so it stays unmatched');
ok(result.candidates.length === 1 && result.candidates[0].party_name === 'Ashok Auto Works',
   'the near-miss is offered to a person instead', JSON.stringify(result.candidates.map((c) => c.party_name)));

console.log('\n11. A person can link it by hand, and that is recorded as a decision');
inv4 = invoices.linkInvoice(inv4.id, 'BE/2627/0404', actor);
ok(inv4.tally_bill_ref === 'BE/2627/0404', 'linked');
ok(inv4.events.some((e) => /by hand/.test(e.note || '')), 'the history says it was done by hand',
   JSON.stringify(inv4.events.map((e) => e.note)));

console.log('\n12. Changing the number throws the old link away');
inv4 = invoices.updateInvoice(inv4.id, { invoiceNumber: 'BE/2627/0405' }, actor);
ok(inv4.tally_bill_ref === null, 'the stale link is cleared rather than left pointing at the old bill');
ok(inv4.position.status === 'unmatched', 'and it is unmatched again until a bill is found');

console.log('\n13. Matching is retried after a sync, not only when raised');
bill('BE/2627/0405', 'Sanghvi Industries Pvt Ltd', {
  billDate: iso(1), dueDate: iso(-29), opening: 11800, outstanding: 11800,
});
const swept = invoices.matchAll();
ok(swept.matched === 1, 'the sweep found it', JSON.stringify(swept));
ok(invoices.getInvoice(inv4.id).position.status === 'outstanding', 'and it now reads as outstanding');

console.log('\n14. A matched invoice is never re-examined by the sweep');
// The failure this guards against: the sweep helpfully "fixing" a paid invoice
// by unlinking it, which turns settled money back into a chase.
const before = invoices.getInvoice(inv3.id).tally_bill_ref;
invoices.matchAll();
ok(invoices.getInvoice(inv3.id).tally_bill_ref === before, 'the paid one keeps its link', String(before));
ok(invoices.getInvoice(inv3.id).position.status === 'paid', 'and still reads as paid');

console.log('\n15. Spacing and case do not stop a match; a different number does');
const order5 = makeOrder('4500200005');
const d5 = shipItAll(order5);
bill('BE/2627/0500', 'Sanghvi Industries Pvt Ltd', {
  billDate: iso(2), dueDate: iso(-28), opening: 11800, outstanding: 11800,
});
const inv5 = invoices.raiseInvoice({ dispatchId: d5.id, invoiceNumber: ' be/2627/0500 ' }, actor);
ok(inv5.tally_bill_ref === 'BE/2627/0500', 'lower case with stray spaces still matches');

const order6 = makeOrder('4500200006');
const d6 = shipItAll(order6);
const inv6 = invoices.raiseInvoice({ dispatchId: d6.id, invoiceNumber: 'BE/2627/500' }, actor);
ok(inv6.tally_bill_ref === null, 'but a dropped zero is a different bill, and is not matched');

console.log('\n16. What the summary says');
const s = invoices.invoiceSummary();
ok(s.invoices === 5, 'five invoices — the pick list in step 2 was never one', String(s.invoices));
ok(s.paidCount === 1, 'one paid', String(s.paidCount));
ok(s.overdueCount === 0, 'none overdue now', String(s.overdueCount));
ok(s.unmatched === 1, 'one unmatched', String(s.unmatched));
ok(s.outstandingValue > 0, 'and a real outstanding figure', String(s.outstandingValue));

console.log('\n17. A link to a real bill for the right customer, but the wrong amount');
// The mistake the party rule cannot catch: a reference typed one digit out
// that happens to be another genuine bill for the same customer. Numbers
// match, party matches, nothing throws — and every figure shown belongs to a
// different consignment. The amounts are the only thing that gives it away.
const order7 = makeOrder('4500200007');
const d7 = shipItAll(order7);
bill('BE/2627/0700', 'Sanghvi Industries Pvt Ltd', {
  billDate: iso(3), dueDate: iso(-27), opening: 248000, outstanding: 248000,
});
const inv7 = invoices.raiseInvoice({ dispatchId: d7.id, invoiceNumber: 'BE/2627/0700', amount: 11800 }, actor);
ok(inv7.position.mismatch !== null, 'the disagreement is reported');
ok(inv7.position.mismatch.recorded === 11800 && inv7.position.mismatch.billed === 248000,
   'naming both figures', JSON.stringify(inv7.position.mismatch));
ok(inv7.position.status === 'outstanding', 'but it is not treated as an error — a person decides');

const inv5again = invoices.getInvoice(inv5.id);
ok(inv5again.position.mismatch === null, 'and an invoice that agrees with its bill is not flagged');

console.log('\n18. Removing an invoice puts its dispatch back in the queue');
invoices.deleteInvoice(inv6.id, actor);
ok(invoices.awaitingInvoice().some((d) => d.id === d6.id), 'the consignment is waiting to be invoiced again');

console.log(`\n${n - fails}/${n} passed${fails ? `, ${fails} FAILED` : ''}\n`);
process.exit(fails ? 1 : 0);
