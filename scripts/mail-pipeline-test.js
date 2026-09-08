/**
 * The mail pipeline, checked end to end against a throwaway database.
 *
 *   npm run mail:test
 *
 * These are not unit tests of the regexes. Each one is a sequence of real
 * mails in the order a real conversation arrives in, asserting the thing that
 * actually matters: that the right number of records exist afterwards. The
 * failure this guards against is not a crash — it is a second order quietly
 * appearing for a purchase order that was already recorded, or a mail landing
 * on the wrong customer, and neither of those throws anything.
 *
 * It writes to data/mail-test.db and never touches the working database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDb = path.join(root, 'data', 'mail-test.db');
for (const f of [testDb, `${testDb}-wal`, `${testDb}-shm`]) fs.rmSync(f, { force: true });
process.env.DB_PATH = testDb;
process.env.MAIL_OWN_DOMAINS = 'balajienterprises.in';
process.env.MAIL_OWN_ADDRESSES = '';

const { db, seedUsers } = await import('../src/db/index.js');
seedUsers();
const mail = await import('../src/mail/service.js');

// Two ledgers, so matching a customer has something to match against.
const now = new Date().toISOString();
db.prepare(`INSERT OR REPLACE INTO tally_ledgers (guid,name,is_customer,credit_limit,outstanding,synced_at) VALUES (?,?,1,500000,120000,?)`)
  .run('g-sanghvi', 'Sanghvi Industries Pvt Ltd', now);
db.prepare(`INSERT OR REPLACE INTO tally_ledgers (guid,name,is_customer,credit_limit,outstanding,synced_at) VALUES (?,?,1,300000,50000,?)`)
  .run('g-ashok', 'Ashok Auto Works', now);

let n = 0, fails = 0;
const ok = (cond, label, extra = '') => {
  n++;
  if (!cond) { fails++; console.log(`  FAIL  ${label} ${extra}`); } else console.log(`  ok    ${label}`);
};

const msg = (o) => ({ gmailThreadId: o.gmailThreadId || o.gmailMessageId, sentAt: o.sentAt || '2026-09-01T10:00:00Z', ...o });
console.log('\n1. An enquiry from a known company mints a quote');
let r = mail.ingestMessage(msg({
  gmailMessageId: 'm1', gmailThreadId: 'gt1',
  from: '"Sanghvi Industries Pvt Ltd" <purchase@sanghvi.co.in>',
  subject: 'Enquiry for pneumatic fittings — RFQ 887766',
  bodyText: 'Dear sir, kindly quote your best rates for the attached list.',
  permalink: 'https://mail.google.com/mail/u/0/#inbox/m1',
}));
ok(r.status==='created', 'created', JSON.stringify(r));
ok(r.classifiedAs==='inquiry', 'classified as inquiry', r.classifiedAs);
ok(/^BE\/Q\//.test(r.quoteNumber||''), 'minted a quote number', r.quoteNumber);
ok(r.needsReview===false, 'not flagged for review', r.reviewReason);
const thread1 = r.threadId, quote1 = r.quoteNumber;

console.log('\n2. The same message pushed again changes nothing');
let r2 = mail.ingestMessage(msg({ gmailMessageId:'m1', gmailThreadId:'gt1', from:'x <purchase@sanghvi.co.in>', subject:'Enquiry' }));
ok(r2.status==='duplicate', 'answered duplicate', r2.status);
ok(db.prepare('SELECT COUNT(*) n FROM quotations').get().n===1, 'still exactly one quotation');

console.log('\n3. A reply in the same Gmail chain joins, mints nothing');
r = mail.ingestMessage(msg({ gmailMessageId:'m2', gmailThreadId:'gt1', from:'purchase@sanghvi.co.in',
  subject:'Re: Enquiry for pneumatic fittings — RFQ 887766', bodyText:'Any update on the quotation?' , sentAt:'2026-09-02T09:00:00Z'}));
ok(r.threadId===thread1, 'same thread', `${r.threadId} vs ${thread1}`);
ok(db.prepare('SELECT COUNT(*) n FROM quotations').get().n===1, 'still one quotation');

console.log('\n4. Our own reply is logged but never classified');
r = mail.ingestMessage(msg({ gmailMessageId:'m3', gmailThreadId:'gt1', from:'sales@balajienterprises.in',
  direction:'out', subject:'Re: Enquiry — our quotation attached',
  bodyText:'Please find our quotation, rates and prices as requested. Kindly quote confirmation.', sentAt:'2026-09-02T11:00:00Z'}));
ok(r.threadId===thread1, 'joined the thread');
ok(r.classifiedAs==='ignored', 'not classified', r.classifiedAs);
ok(db.prepare('SELECT COUNT(*) n FROM quotations').get().n===1, 'no second quotation from our own mail');

console.log('\n5. Their PO arrives as a BRAND NEW Gmail thread, same reference');
r = mail.ingestMessage(msg({ gmailMessageId:'m4', gmailThreadId:'gt2', from:'"Sanghvi Industries" <accounts@sanghvi.co.in>',
  subject:'Purchase Order against RFQ 887766', bodyText:'Kindly supply as per your quotation.',
  attachments:[{name:'PO_4500123456.pdf', mimeType:'application/pdf', size:81000, url:'https://drive.google.com/file/d/abc/view'}],
  sentAt:'2026-09-05T10:00:00Z'}));
ok(r.threadId===thread1, 'merged into the SAME thread as the enquiry', `${r.threadId} vs ${thread1}`);
ok(/^BE\/SO\//.test(r.orderNumber||''), 'minted an SO number', JSON.stringify(r));
const so = r.orderNumber, order1 = r.orderId;
if(!order1){ console.log('   ABORT:', JSON.stringify(r,null,2)); process.exit(1); }
const ord = db.prepare('SELECT * FROM orders WHERE id=?').get(order1);
ok(ord.quotation_id !== null, 'order carries its quotation');
ok(db.prepare('SELECT status FROM quotations WHERE id=?').get(ord.quotation_id).status==='accepted', 'quotation marked accepted');
ok(ord.document_url==='https://drive.google.com/file/d/abc/view', 'PDF link on the order', ord.document_url);
ok(ord.customer_guid==='g-sanghvi', 'tied to the Tally ledger', ord.customer_guid);
ok(ord.customer_po_number==='887766', 'their reference recorded as the PO number', ord.customer_po_number);

console.log('\n6. A follow-up on the order does NOT create a second order');
r = mail.ingestMessage(msg({ gmailMessageId:'m5', gmailThreadId:'gt2', from:'accounts@sanghvi.co.in',
  subject:'Re: Purchase Order against RFQ 887766', bodyText:'Please confirm the delivery schedule for this purchase order.', sentAt:'2026-09-05T15:00:00Z'}));
ok(r.threadId===thread1, 'same thread');
ok(db.prepare('SELECT COUNT(*) n FROM orders').get().n===1, 'still exactly one order');

console.log('\n7. A NEW PO number in the SAME Gmail chain opens its own record');
r = mail.ingestMessage(msg({ gmailMessageId:'m6', gmailThreadId:'gt2', from:'accounts@sanghvi.co.in',
  subject:'Re: Purchase Order — new PO No. 4500999888', bodyText:'Kindly supply against this new purchase order.', sentAt:'2026-09-06T09:00:00Z'}));
ok(r.threadId!==thread1, 'a separate thread', `${r.threadId} vs ${thread1}`);
ok(/^BE\/SO\//.test(r.orderNumber||'') && r.orderNumber!==so, 'its own SO number', r.orderNumber);
ok(db.prepare('SELECT COUNT(*) n FROM orders').get().n===2, 'two orders now');
// This mail came from accounts@ with no display name at all. The domain was
// already identified on the enquiry thread, so it is not asked about again.
ok(mail.getThread(r.threadId).customer_guid === 'g-sanghvi',
  'a bare address on a known company domain still lands on the right customer',
  mail.getThread(r.threadId).customer_name);

console.log('\n8. Two different customers, the same PO number, never merge');
r = mail.ingestMessage(msg({ gmailMessageId:'m7', gmailThreadId:'gt3', from:'"Ashok Auto Works" <po@ashokauto.com>',
  subject:'Purchase Order No. 887766', bodyText:'Kindly supply the following.', sentAt:'2026-09-06T10:00:00Z'}));
ok(r.threadId!==thread1, 'own thread, not Sanghvi\'s', `${r.threadId}`);
const t7 = mail.getThread(r.threadId);
ok(t7.customer_name==='Ashok Auto Works', 'matched to Ashok by display name', t7.customer_name);

console.log('\n9. An ambiguous mail refuses to decide and waits for a person');
r = mail.ingestMessage(msg({ gmailMessageId:'m8', gmailThreadId:'gt4', from:'"Rakesh" <rakesh.traders@gmail.com>',
  subject:'Requirement', bodyText:'Sir, need some items urgently.', sentAt:'2026-09-06T11:00:00Z'}));
ok(r.classifiedAs==='unclassified', 'unclassified', r.classifiedAs);
ok(!r.orderNumber && !r.quoteNumber, 'no number minted');
ok(r.needsReview===true, 'in the review queue');
const t9 = mail.getThread(r.threadId);
ok(t9.party_key==='email:rakesh.traders@gmail.com', 'gmail sender keys on the address, not the domain', t9.party_key);

console.log('\n10. A second unrelated Gmail sender does not collide with the first');
r = mail.ingestMessage(msg({ gmailMessageId:'m9', gmailThreadId:'gt5', from:'"Vinod" <vinod.eng@gmail.com>',
  subject:'PO 887766', bodyText:'Kindly supply.', sentAt:'2026-09-06T12:00:00Z'}));
const t10 = mail.getThread(r.threadId);
ok(t10.party_key==='email:vinod.eng@gmail.com', 'keyed on its own address', t10.party_key);
ok(t10.id!==t9.id && t10.id!==thread1, 'a thread of its own');
ok(/^BE\/SO\//.test(r.orderNumber||''), 'a bare "PO 887766" subject is enough to mint an order', JSON.stringify(r));

console.log('\n11. Out-of-office is logged, not acted on');
const ordersBefore = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
r = mail.ingestMessage(msg({ gmailMessageId:'m10', gmailThreadId:'gt1', from:'purchase@sanghvi.co.in',
  subject:'Automatic reply: Enquiry for pneumatic fittings', bodyText:'I am out of office.',
  headers:{'Auto-Submitted':'auto-replied'}, sentAt:'2026-09-06T13:00:00Z'}));
ok(r.classifiedAs==='ignored', 'ignored', `${r.classifiedAs} / ${r.reason}`);
ok(db.prepare('SELECT COUNT(*) n FROM orders').get().n===ordersBefore, 'no new order');

console.log('\n12. A person classifies the ambiguous one, and it takes a number');
const done = mail.classifyThread(t9.id, 'inquiry', {id:1,name:'Shubh'});
ok(done.quotation_id!==null, 'quotation raised');
ok(done.kind==='inquiry', 'kind set', done.kind);
const t9b = mail.getThread(t9.id);
ok(/^BE\/Q\//.test(t9b.quote_number||''), 'has a quote number', t9b.quote_number);
ok(t9b.needs_review===1 && /ledger/.test(t9b.review_reason||''), 'still flagged: sender has no ledger', t9b.review_reason);

console.log('\n13. Binding the sender clears the flag');
const bind = mail.bindParty({scope:'address', value:'rakesh.traders@gmail.com', customerName:'Ashok Auto Works'}, {id:1});
ok(bind.threadsUpdated>=1, 'threads re-keyed', JSON.stringify(bind));
const t9c = mail.getThread(t9.id);
ok(t9c.customer_guid==='g-ashok', 'now tied to the ledger', t9c.customer_guid);
ok(t9c.needs_review===0, 'no longer in review', t9c.review_reason);

console.log('\n14. Binding a free-mail DOMAIN is refused');
try { mail.bindParty({scope:'domain', value:'gmail.com', customerName:'Ashok Auto Works'}, {id:1}); ok(false,'should have thrown'); }
catch (e) { ok(/free mail/.test(e.message), 'refused', e.message); }

console.log('\n15. A mail quoting our own SO number binds straight to it');
r = mail.ingestMessage(msg({ gmailMessageId:'m11', gmailThreadId:'gt9', from:'accounts@sanghvi.co.in',
  subject:`Payment advice for ${so}`, bodyText:'Enclosed.', sentAt:'2026-09-07T09:00:00Z'}));
ok(r.threadId===thread1, 'landed on the order\'s own thread', `${r.threadId} vs ${thread1}`);

console.log('\n16. A PO hand-forwarded into the consolidation inbox still becomes an order');
// sales@ is a consolidation inbox: accounts@, rediffmail and a personal gmail
// all feed into it. A forward done by hand arrives from OUR OWN address, with
// the customer only in the quoted header block. Read naively it looks like mail
// we sent — never classified, never numbered, silently gone.
r = mail.ingestMessage(msg({
  gmailMessageId: 'fwd-1', gmailThreadId: 'fwd-t1',
  folder: 'inbox',
  from: 'Balaji Accounts <accounts@balajienterprises.in>',
  to: 'sales@balajienterprises.in',
  subject: 'Fwd: Purchase Order No. 4500334455',
  bodyText: [
    '---------- Forwarded message ---------',
    'From: Bhavna Sharma <purchase@sanghvi.co.in>',
    'Date: Mon, 7 Sep 2026 at 10:12',
    'Subject: Purchase Order No. 4500334455',
    'To: accounts@balajienterprises.in',
    '',
    'Dear Sir, kindly supply the attached items.',
  ].join('\n'),
  attachments: [{ name: 'PO_4500334455.pdf', mimeType: 'application/pdf', size: 4242 }],
  sentAt: '2026-09-07T10:30:00Z',
}));
ok(/^BE\/SO\//.test(r.orderNumber || ''), 'a hand-forwarded PO still mints an SO', JSON.stringify(r));
const fwdThread = mail.getThread(r.threadId);
ok(fwdThread.customer_guid === 'g-sanghvi', 'filed against the real customer, not ourselves', fwdThread.customer_name);
ok(r.warnings.some((w) => /Forwarded into the inbox/.test(w)), 'the forward is reported, not hidden', JSON.stringify(r.warnings));

console.log('\n17. Mail that looks like ours, with no original sender, raises nothing');
// A forward whose provenance was lost, or a sweep that misjudged Sent. Either
// way the only customer name available is our own, so minting would open an
// order against Balaji Enterprises itself.
r = mail.ingestMessage(msg({
  gmailMessageId: 'ours-1', gmailThreadId: 'ours-t1',
  folder: 'inbox',
  from: 'Sales <sales@balajienterprises.in>',
  to: 'sales@balajienterprises.in',
  subject: 'Purchase Order No. 5500110022',
  bodyText: 'Kindly supply the attached items as per your quotation.',
  sentAt: '2026-09-07T10:45:00Z',
}));
ok(r.classifiedAs === 'unclassified', 'not classified', `${r.classifiedAs} / ${r.reason}`);
ok(!r.orderNumber && !r.quoteNumber, 'nothing minted against ourselves', JSON.stringify(r));
ok(r.needsReview === true, 'queued for a person');

console.log('\n18. Mail we actually sent is still never classified');
r = mail.ingestMessage(msg({
  gmailMessageId: 'sent-1', gmailThreadId: 'sent-t1',
  folder: 'sent',
  from: 'Sales <sales@balajienterprises.in>',
  to: 'Bhavna Sharma <purchase@sanghvi.co.in>',
  subject: 'Our quotation for your enquiry',
  bodyText: 'Please find our quotation attached. Kindly quote your confirmation.',
  sentAt: '2026-09-07T11:00:00Z',
}));
ok(r.classifiedAs === 'ignored', 'ignored because Gmail says it came from Sent', r.classifiedAs);

console.log('\n18. A shared provider is never accepted as one of our own domains');
// The rediffmail account forwards into sales@, so rediffmail.com looks like it
// belongs in MAIL_OWN_DOMAINS. It must be refused: half the buyers in
// Pithampur are on rediffmail, and their orders would silently stop appearing.
process.env.MAIL_OWN_DOMAINS = 'balajienterprises.in,rediffmail.com';
r = mail.ingestMessage(msg({
  gmailMessageId: 'rediff-1', gmailThreadId: 'rediff-t1',
  from: 'Ashok Auto Works <ashokauto@rediffmail.com>',
  subject: 'Purchase Order No. 7788991',
  bodyText: 'Kindly supply the attached items.',
  sentAt: '2026-09-07T12:00:00Z',
}));
ok(r.classifiedAs === 'order', 'a customer on rediffmail is still a customer', r.classifiedAs);
ok(/^BE\/SO\//.test(r.orderNumber || ''), 'and still gets an order number', r.orderNumber);
process.env.MAIL_OWN_DOMAINS = 'balajienterprises.in';
process.env.MAIL_OWN_ADDRESSES = '';

console.log('\n19. Binding a sender never collapses two records onto one key');
// Ashok already holds a thread for reference 887766 (test 8). Vinod's thread
// holds the same reference and its own order. Binding Vinod to Ashok must not
// merge them — that would destroy an order — and must not leave both under one
// key either, which would make a future mail's landing place a matter of luck.
const beforeBind = db.prepare('SELECT COUNT(*) n FROM orders').get().n;
const bind2 = mail.bindParty({ scope: 'address', value: 'vinod.eng@gmail.com', customerName: 'Ashok Auto Works' }, { id: 1 });
ok(db.prepare('SELECT COUNT(*) n FROM orders').get().n === beforeBind, 'no order destroyed');
ok(bind2.conflicts.length === 1, 'the collision is reported, not silently resolved', JSON.stringify(bind2));
const keyed = db.prepare(`SELECT party_key, customer_ref, COUNT(*) n FROM mail_threads
                          WHERE customer_ref IS NOT NULL GROUP BY party_key, customer_ref HAVING n > 1`).all();
ok(keyed.length === 0, 'no two threads share a party key and reference', JSON.stringify(keyed));
ok(db.prepare('SELECT needs_review FROM mail_threads WHERE id = ?').get(t10.id).needs_review === 1,
  'both threads are flagged for a person');

console.log('\n20. Numbers are unique and sequential');
const nums = db.prepare('SELECT order_number FROM orders ORDER BY id').all().map(x=>x.order_number);
ok(new Set(nums).size===nums.length, 'no duplicate SO numbers', nums.join(', '));
const qn = db.prepare('SELECT quote_number FROM quotations ORDER BY id').all().map(x=>x.quote_number);
ok(new Set(qn).size===qn.length, 'no duplicate quote numbers', qn.join(', '));
console.log('   SO:', nums.join(', '), '\n   Q :', qn.join(', '));

console.log('\n21. Summary');
console.log('  ', JSON.stringify(mail.mailSummary()));
console.log('   unresolved senders:', JSON.stringify(mail.unresolvedSenders()));

console.log(`\n${n - fails}/${n} passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
