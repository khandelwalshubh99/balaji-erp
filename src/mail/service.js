/**
 * The mail log.
 *
 * One job: every mail that matters ends up attached to exactly one record, and
 * that record has an id. A purchase order becomes an order and gets a
 * BE/SO/… number; an enquiry becomes a draft quotation and gets a BE/Q/…
 * number; anything the rules cannot call gets neither, and waits for a person.
 *
 * The whole design is arranged around one failure being much worse than the
 * other. Recording the same order twice is annoying and visible. Filing a mail
 * onto the WRONG customer's record is invisible, and stays invisible until
 * someone chases a payment against an order that was never really theirs. So
 * nothing here merges on a weak signal, and refusing to decide is a first-class
 * outcome rather than an error path.
 */
import { db } from '../db/index.js';
import { config } from '../config.js';
import { matchCustomer } from '../customers/service.js';
import * as orders from '../orders/service.js';
import * as quotes from '../quotations/service.js';
import {
  cleanSubject, extractCustomerRef, extractOurRef, normaliseRef,
  parseAddress, classify, isNoise, FREE_MAIL_DOMAINS,
  extractForwardedSenders, looksForwarded,
} from './classify.js';

const str = (v, max = 500) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

/** An instant, kept as an instant. Mails have times; quotations have dates. */
function isoInstant(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
const dateOf = (instant) => String(instant).slice(0, 10);

// ---------------------------------------------------------------------------
// Who sent it
// ---------------------------------------------------------------------------

/**
 * Turn a sender into a party key.
 *
 * The key is derived from the ADDRESS and nothing else. That is the whole
 * point: the same person writes "Sanghvi Industries Pvt Ltd <purchase@…>" on
 * Monday and a bare "purchase@…" on Tuesday, and if the display name were part
 * of the key those two mails would land on two different records — which is
 * exactly the duplication this exists to prevent. Who they are is an attribute
 * of the thread, resolved as well as it can be; what threads hang off is the
 * address, which does not move.
 *
 * Hence the free-mail rule too: a company domain identifies a company, but
 * gmail.com identifies nothing, so those senders key on the whole address.
 */
export function resolveParty({ fromName, fromEmail }) {
  const email = String(fromEmail || '').toLowerCase() || null;
  const domain = email ? email.split('@')[1] || null : null;
  const free = domain ? FREE_MAIL_DOMAINS.has(domain) : true;

  const byAddress = email
    ? db.prepare(`SELECT customer_name, customer_guid FROM mail_party_map WHERE scope = 'address' AND value = ?`).get(email)
    : null;
  const byDomain = domain
    ? db.prepare(`SELECT customer_name, customer_guid FROM mail_party_map WHERE scope = 'domain' AND value = ?`).get(domain)
    : null;
  const bound = byAddress || byDomain;

  const partyKey = bound
    ? `cust:${bound.customer_guid || bound.customer_name}`
    : free
    ? `email:${email || 'unknown'}`
    : `domain:${domain}`;

  if (bound) {
    return { partyKey, customerName: bound.customer_name, customerGuid: bound.customer_guid, method: byAddress ? 'learned-address' : 'learned-domain', email, domain };
  }

  // Their display name against the Tally ledgers. matchCustomer refuses on an
  // ambiguous name rather than picking, which is the behaviour wanted here too.
  // This names the party; it never keys it.
  const named = matchCustomer(fromName || '');
  if (named.matched) {
    return { partyKey, customerName: named.name, customerGuid: named.guid, method: `name-${named.method}`, email, domain };
  }

  // A company domain that has already been identified on another thread stays
  // identified. The same customer writes from purchase@ on Monday and from
  // accounts@ on Tuesday, and the second one often leaves the display name off;
  // asking again for a sender already recognised is the noise that makes a
  // review queue get ignored. Free-mail domains are excluded, for the same
  // reason they never key a thread.
  if (!free && domain) {
    const seen = db.prepare(`
      SELECT t.customer_name, t.customer_guid
      FROM mail_threads t JOIN mail_messages m ON m.thread_id = t.id
      WHERE t.customer_guid IS NOT NULL AND m.from_email LIKE '%@' || ?
      ORDER BY m.id DESC LIMIT 1`).get(domain);
    if (seen) {
      return { partyKey, customerName: seen.customer_name, customerGuid: seen.customer_guid, method: 'domain-seen-before', email, domain };
    }
  }

  return {
    partyKey,
    customerName: str(fromName, 200) || email || 'Unknown sender',
    customerGuid: null,
    method: 'unresolved',
    email,
    domain,
  };
}

const csv = (value) =>
  String(value || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);

/**
 * Our own domains — with free-mail providers refused outright.
 *
 * Listing rediffmail.com or gmail.com here would mark every customer using
 * that provider as us, and mail from us is never classified and never numbered.
 * The mistake is easy to make and impossible to notice: orders simply stop
 * appearing. So it is rejected loudly at startup rather than obeyed.
 */
let warnedOwnDomains = false;
const ownDomains = () => {
  const listed = csv(config.mail?.ownDomains);
  const shared = listed.filter((d) => FREE_MAIL_DOMAINS.has(d));
  if (shared.length && !warnedOwnDomains) {
    warnedOwnDomains = true;
    console.warn(
      `[mail] IGNORING ${shared.join(', ')} in MAIL_OWN_DOMAINS — that is a shared mail provider, ` +
      `and treating it as ours would hide every customer who uses it. ` +
      `Put the individual address in MAIL_OWN_ADDRESSES instead.`
    );
  }
  return listed.filter((d) => !FREE_MAIL_DOMAINS.has(d));
};

const ownAddresses = () => csv(config.mail?.ownAddresses);

/**
 * The first address out of a header that may list several. Written by hand
 * rather than by splitting on commas, because "Doe, John <j@x.com>" is a legal
 * header and splitting it produces two addresses, neither of them real.
 */
function firstAddress(list) {
  const s = String(list || '');
  const angled = /<([^>]+)>/.exec(s);
  if (angled) return parseAddress(s.slice(0, s.indexOf(angled[0]) + angled[0].length));
  const bare = /[^\s,;<>"]+@[^\s,;<>"]+/.exec(s);
  return bare ? parseAddress(bare[0]) : { name: null, email: null, domain: null };
}

const isOwnAddress = (email) => {
  const address = String(email || '').toLowerCase();
  if (!address) return false;
  if (ownAddresses().includes(address)) return true;
  const domain = address.split('@')[1] || '';
  return Boolean(domain) && ownDomains().includes(domain);
};

/**
 * Did we send this, or did we receive it?
 *
 * Gmail's own answer wins. `folder` says which of Sent and Inbox the sweep
 * found the message in, and that is a fact rather than an inference — which
 * matters enormously here, because sales@ is a consolidation inbox. Mail
 * forwarded in from accounts@ or from the rediffmail account arrives with OUR
 * domain in the From line while being, plainly, incoming mail. Reading the
 * domain alone would file every one of those as something we sent, and mail we
 * sent is never classified and never given a number: the purchase order would
 * vanish without a trace.
 *
 * The domain check is only the fallback for a caller that cannot say.
 */
function directionOf({ fromEmail, claimed, folder }) {
  if (folder === 'sent') return 'out';
  if (folder === 'inbox') return 'in';
  if (ownDomains().length || ownAddresses().length) return isOwnAddress(fromEmail) ? 'out' : 'in';
  return claimed === 'out' ? 'out' : 'in';
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

const threadById = (id) => db.prepare('SELECT * FROM mail_threads WHERE id = ?').get(id);

/**
 * Recompute what a thread looks like from the rows underneath it, and whether
 * it still needs a person. Derived rather than maintained by hand: a counter
 * that drifts is worse than one that is recalculated.
 */
function refreshThread(threadId) {
  const agg = db.prepare(`
    SELECT COUNT(*) AS n,
           SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS incoming,
           MIN(sent_at) AS first_at, MAX(sent_at) AS last_at
    FROM mail_messages WHERE thread_id = ?`).get(threadId);
  const t = threadById(threadId);
  if (!t) return null;

  const reasons = [];
  if (t.kind !== 'ignored') {
    if (t.kind === 'unclassified' && (agg.incoming || 0) > 0) {
      reasons.push('not classified as an order or an enquiry');
    }
    if (!t.customer_guid) reasons.push('sender is not tied to a Tally ledger');
  }

  db.prepare(`
    UPDATE mail_threads SET message_count = ?, first_message_at = ?, last_message_at = ?,
      needs_review = ?, review_reason = ?, updated_at = datetime('now')
    WHERE id = ?`)
    .run(agg.n || 0, agg.first_at || null, agg.last_at || null,
      reasons.length ? 1 : 0, reasons.join('; ') || null, threadId);
  return threadById(threadId);
}

/**
 * Fold one thread into another.
 *
 * Only ever called when two rows are shown to be the same conversation — most
 * often because a sender domain was bound to a customer and two keys collapsed
 * into one. Two threads that BOTH carry an order are never merged: that is two
 * real orders, and losing one to tidy up a key would be the worst thing this
 * code could do.
 */
export function mergeThreads(aId, bId, note = 'merged') {
  if (aId === bId) return threadById(aId);
  const a = threadById(aId);
  const b = threadById(bId);
  if (!a || !b) return null;
  if (a.order_id && b.order_id && a.order_id !== b.order_id) return null;
  if (a.quotation_id && b.quotation_id && a.quotation_id !== b.quotation_id) return null;

  // The one holding the more advanced record survives, so no minted id is ever
  // orphaned; failing that, the older one, so history reads in order.
  const rank = (t) => (t.order_id ? 2 : t.quotation_id ? 1 : 0);
  const [keep, drop] = rank(a) !== rank(b) ? (rank(a) > rank(b) ? [a, b] : [b, a]) : a.id < b.id ? [a, b] : [b, a];

  return db.transaction(() => {
    // Release the loser's reference first: the unique index on
    // (party_key, customer_ref) will not tolerate both rows holding it.
    db.prepare('UPDATE mail_threads SET customer_ref = NULL WHERE id = ?').run(drop.id);
    db.prepare(`
      UPDATE mail_threads SET
        customer_ref     = COALESCE(customer_ref, ?),
        customer_ref_raw = COALESCE(customer_ref_raw, ?),
        customer_name    = COALESCE(customer_name, ?),
        customer_guid    = COALESCE(customer_guid, ?),
        order_id         = COALESCE(order_id, ?),
        quotation_id     = COALESCE(quotation_id, ?),
        kind             = CASE WHEN kind IN ('unclassified','ignored') THEN ? ELSE kind END,
        updated_at       = datetime('now')
      WHERE id = ?`)
      .run(drop.customer_ref, drop.customer_ref_raw, drop.customer_name, drop.customer_guid,
        drop.order_id, drop.quotation_id, drop.kind, keep.id);
    db.prepare('UPDATE mail_messages SET thread_id = ? WHERE thread_id = ?').run(keep.id, drop.id);
    db.prepare('DELETE FROM mail_threads WHERE id = ?').run(drop.id);
    console.log(`[mail] merged thread ${drop.id} into ${keep.id} (${note})`);
    return refreshThread(keep.id);
  })();
}

/** The thread holding a given minted record, if a mail ever produced one. */
const threadForOrder = (id) => db.prepare('SELECT * FROM mail_threads WHERE order_id = ?').get(id);
const threadForQuote = (id) => db.prepare('SELECT * FROM mail_threads WHERE quotation_id = ?').get(id);

/**
 * A revision is a new row, so the id a mail minted stops being the live one the
 * moment the quotation is revised. The thread keeps pointing at the row it
 * created — that is the honest record of what the mail produced — and every
 * reading of it resolves forward to the version that is current, so a person
 * is never sent to a superseded quotation.
 */
function currentQuotation(quotationId) {
  if (!quotationId) return null;
  const q = db.prepare('SELECT quote_number FROM quotations WHERE id = ?').get(quotationId);
  if (!q) return null;
  return db.prepare('SELECT * FROM quotations WHERE quote_number = ? AND is_current = 1').get(q.quote_number)
    || db.prepare('SELECT * FROM quotations WHERE id = ?').get(quotationId);
}

function createThread({ partyKey, customerName, customerGuid, ref, subject, kind = 'unclassified' }) {
  const info = db.prepare(`
    INSERT INTO mail_threads (party_key, customer_name, customer_guid, customer_ref, customer_ref_raw, subject, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(partyKey, customerName || null, customerGuid || null,
      ref?.key || null, ref?.raw || null, subject || '(no subject)', kind);
  return threadById(info.lastInsertRowid);
}

/**
 * Which record does this mail belong to?
 *
 * Strongest signal first, and each step is a statement about the mail rather
 * than a similarity score:
 *
 *   1. It quotes one of OUR numbers. Conclusive — that is the record, by name.
 *   2. It carries THEIR reference. A deliberate statement of what the mail is
 *      about, which is why it outranks the Gmail chain: a customer replying to
 *      a month-old chain with a fresh PO number means a fresh order, and
 *      following the chain there would bury it inside the old one.
 *   3. It is a reply in a Gmail conversation we already know. Followed to
 *      whichever record that conversation most recently touched.
 *   4. Nothing to go on — a new thread of its own.
 */
function resolveThreadFor({ ourRef, ref, party, gmailThreadId, subject }) {
  if (ourRef) {
    const table = ourRef.kind === 'order' ? 'orders' : 'quotations';
    const col = ourRef.kind === 'order' ? 'order_number' : 'quote_number';
    const row = db.prepare(`SELECT id FROM ${table} WHERE ${col} = ? ORDER BY id LIMIT 1`).get(ourRef.number);
    if (row) {
      const existing = ourRef.kind === 'order' ? threadForOrder(row.id) : threadForQuote(row.id);
      if (existing) return { thread: existing, how: `quotes our ${ourRef.number}` };
      const t = createThread({ ...party, ref, subject, kind: ourRef.kind === 'order' ? 'order' : 'inquiry' });
      db.prepare(`UPDATE mail_threads SET ${ourRef.kind === 'order' ? 'order_id' : 'quotation_id'} = ?, decided_by = 'reference', decided_at = datetime('now') WHERE id = ?`)
        .run(row.id, t.id);
      return { thread: threadById(t.id), how: `quotes our ${ourRef.number}` };
    }
    // A number we never issued. Not a reason to reject the mail — it is a
    // reason to make sure a person sees it.
  }

  if (ref) {
    const hit = db.prepare('SELECT * FROM mail_threads WHERE party_key = ? AND customer_ref = ? ORDER BY id LIMIT 1')
      .get(party.partyKey, ref.key);
    if (hit) return { thread: hit, how: `their reference ${ref.raw}` };
    return { thread: createThread({ ...party, ref, subject }), how: `new — reference ${ref.raw}` };
  }

  if (gmailThreadId) {
    const hit = db.prepare(`
      SELECT t.* FROM mail_messages m JOIN mail_threads t ON t.id = m.thread_id
      WHERE m.gmail_thread_id = ? ORDER BY m.sent_at DESC, m.id DESC LIMIT 1`).get(gmailThreadId);
    if (hit) return { thread: hit, how: 'reply in a conversation already logged' };
  }

  return { thread: createThread({ ...party, ref: null, subject }), how: 'new conversation' };
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

const actorFor = (actor) => actor || { id: null, name: 'Gmail ingest' };

/**
 * Give a thread its number.
 *
 * An order arrives with no line items on purpose: they are inside the attached
 * PDF, and a parser that reads PO layouts right 85% of the time is worse than
 * none, because someone still has to check all of it to find the 15%. So the
 * order lands in "Items not entered" with the mail and the attachment linked.
 */
function mintOrder(thread, message, actor) {
  const existing = thread.order_id ? db.prepare('SELECT * FROM orders WHERE id = ?').get(thread.order_id) : null;
  if (existing) return { order: existing, created: false, warnings: [] };

  const attachmentUrl = firstAttachmentUrl(message);
  const order = orders.createOrder(
    {
      customerName: thread.customer_name || message.from_email || 'Unknown sender',
      customerGuid: thread.customer_guid,
      customerPoNumber: thread.customer_ref_raw,
      poDate: dateOf(message.sent_at),
      receivedAt: dateOf(message.sent_at),
      notes: message.subject_clean,
      lines: [],
      source: 'email',
      sourceRef: `gmail:${message.gmail_message_id}`,
      documentUrl: attachmentUrl || message.permalink,
      // An enquiry that turned into a purchase order carries its quotation
      // with it, which is the whole point of threading the two together.
      quotationId: currentQuotation(thread.quotation_id)?.id || null,
      allowDuplicate: true,
    },
    actorFor(actor)
  );

  const warnings = orders
    .findDuplicates({
      customerName: order.customer_name,
      customerPoNumber: thread.customer_ref_raw,
      total: 0,
      excludeId: order.id,
    })
    .map((d) => d.reason);

  db.prepare(`UPDATE mail_threads SET order_id = ?, kind = 'order', decided_by = COALESCE(decided_by, 'classifier'),
              decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(order.id, thread.id);
  return { order, created: true, warnings };
}

function mintQuotation(thread, message, actor) {
  const existing = thread.quotation_id ? db.prepare('SELECT * FROM quotations WHERE id = ?').get(thread.quotation_id) : null;
  if (existing) return { quotation: existing, created: false };

  const q = quotes.createQuotation(
    {
      customerName: thread.customer_name || message.from_email || 'Unknown sender',
      customerGuid: thread.customer_guid,
      lines: [],
      notes: message.subject_clean,
      quoteDate: dateOf(message.sent_at),
      source: 'email',
      sourceRef: `gmail:${message.gmail_message_id}`,
      documentUrl: firstAttachmentUrl(message) || message.permalink,
    },
    actorFor(actor)
  );
  db.prepare(`UPDATE mail_threads SET quotation_id = ?, kind = 'inquiry', decided_by = COALESCE(decided_by, 'classifier'),
              decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(q.id, thread.id);
  return { quotation: q, created: true };
}

function firstAttachmentUrl(message) {
  try {
    const list = JSON.parse(message.attachments || '[]');
    const withUrl = list.find((a) => a && typeof a.url === 'string' && /^https?:/i.test(a.url));
    return withUrl ? withUrl.url : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Record one Gmail message.
 *
 * Everything below happens inside a single transaction, so a message is either
 * fully recorded — logged, threaded, and its record minted — or not recorded at
 * all. There is no state where an order exists but the mail that produced it
 * does not, which is the state that would make the duplicate key useless.
 */
export function ingestMessage(payload, actor = null) {
  const gmailMessageId = str(payload.gmailMessageId, 120);
  if (!gmailMessageId) return { status: 'error', error: 'gmailMessageId is required' };

  const already = db.prepare('SELECT id, thread_id FROM mail_messages WHERE gmail_message_id = ?').get(gmailMessageId);
  if (already) {
    const t = threadById(already.thread_id);
    return { status: 'duplicate', gmailMessageId, threadId: already.thread_id, reference: referenceOf(t) };
  }

  const from = parseAddress(payload.from);
  const fromName = str(payload.fromName, 200) || from.name;
  const fromEmail = from.email || str(payload.fromEmail, 200);
  const subject = str(payload.subject, 500) || '(no subject)';
  const subjectClean = cleanSubject(subject);
  const body = String(payload.bodyText || payload.body || '').slice(0, 20000);
  const attachments = Array.isArray(payload.attachments) ? payload.attachments.slice(0, 25).map(cleanAttachment) : [];
  const sentAt = isoInstant(payload.sentAt || payload.date);
  const direction = directionOf({ fromEmail, claimed: payload.direction, folder: str(payload.folder, 20) });

  const ourRef = extractOurRef(subjectClean) || extractOurRef(body.slice(0, 4000));
  const ref = extractCustomerRef(subject);
  // The party is always the CUSTOMER — which, for a mail we sent, is whoever it
  // went to. Keying our own sales address as a party would file every quotation
  // we ever send under one imaginary customer called Balaji Enterprises.
  let counterparty = direction === 'out' ? firstAddress(payload.to) : { name: fromName, email: fromEmail };
  let forwardedFrom = null;

  // Incoming mail that arrives from one of our own addresses has been forwarded
  // into the consolidation inbox. The customer is inside the quoted header
  // block, not in the From line, and taking the From line would file the order
  // against ourselves.
  if (direction === 'in' && isOwnAddress(counterparty.email)) {
    const original = extractForwardedSenders(body).find((c) => !isOwnAddress(c.email));
    if (original) {
      forwardedFrom = original;
      counterparty = original;
    }
  }
  const party = resolveParty({ fromName: counterparty.name, fromEmail: counterparty.email });

  const noise = isNoise({ fromEmail, subject, headers: payload.headers || {} });

  /**
   * Mail that appears to come from us but was found in the inbox, with no
   * original sender recoverable from it, never raises a record.
   *
   * It is a forward whose provenance was lost, and the only customer name
   * available is our own — so minting from it would open an order against
   * Balaji Enterprises itself. It is logged and queued for a person instead.
   * This also covers a sweep that misjudged Sent, where the alternative would
   * be raising a quotation off the back of our own quotation email.
   */
  const fromUsUnattributed = direction === 'in' && isOwnAddress(fromEmail) && !forwardedFrom;

  const verdict = noise
    ? { kind: 'ignored', orderScore: 0, inquiryScore: 0, reason: noise }
    : fromUsUnattributed
    ? { kind: 'unclassified', orderScore: 0, inquiryScore: 0,
        reason: `appears to come from our own ${fromEmail} with no original sender in it` }
    : classify({ subject, body, attachments, direction, ref });

  return db.transaction(() => {
    const { thread, how } = resolveThreadFor({ ourRef, ref, party, gmailThreadId: str(payload.gmailThreadId, 120), subject: subjectClean });

    const info = db.prepare(`
      INSERT INTO mail_messages (thread_id, gmail_message_id, gmail_thread_id, rfc_message_id,
        direction, from_name, from_email, to_emails, cc_emails, subject, subject_clean, snippet,
        body_text, sent_at, has_attachments, attachments, permalink,
        classified_as, order_score, inquiry_score, classify_reason, script_verdict,
        extracted_ref, extracted_our_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(thread.id, gmailMessageId, str(payload.gmailThreadId, 120), str(payload.rfcMessageId, 300),
        direction, fromName, fromEmail, str(payload.to, 1000), str(payload.cc, 1000),
        subject, subjectClean, str(payload.snippet, 500), body, sentAt,
        attachments.length ? 1 : 0, attachments.length ? JSON.stringify(attachments) : null,
        str(payload.permalink, 500), verdict.kind, verdict.orderScore, verdict.inquiryScore,
        verdict.reason, str(payload.verdict, 40), ref?.raw || null, ourRef?.number || null);

    const message = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(info.lastInsertRowid);

    // A thread whose reference was unknown when it started takes the first one
    // that turns up in it, unless another record already holds that reference
    // for this party — in which case these two are one conversation.
    let current = threadById(thread.id);

    // A thread that opened from a bare address takes the first proper
    // identification that turns up in it, rather than staying anonymous
    // because the customer happened to leave their display name off once.
    if (!current.customer_guid && party.customerGuid) {
      db.prepare(`UPDATE mail_threads SET customer_name = ?, customer_guid = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(party.customerName, party.customerGuid, current.id);
      current = threadById(current.id);
    }

    if (ref && !current.customer_ref) {
      const clash = db.prepare('SELECT id FROM mail_threads WHERE party_key = ? AND customer_ref = ? AND id != ?')
        .get(current.party_key, ref.key, current.id);
      if (clash) {
        const merged = mergeThreads(clash.id, current.id, `both carry ${ref.raw}`);
        if (merged) current = merged;
      } else {
        db.prepare('UPDATE mail_threads SET customer_ref = ?, customer_ref_raw = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(ref.key, ref.raw, current.id);
        current = threadById(current.id);
      }
    }

    const out = { status: 'created', gmailMessageId, threadId: current.id, how, classifiedAs: verdict.kind, reason: verdict.reason, warnings: [] };

    if (payload.verdict && payload.verdict !== verdict.kind) {
      out.warnings.push(`The script read this as "${payload.verdict}"; the server reads it as "${verdict.kind}" and the server's reading is the one used.`);
    }
    if (forwardedFrom) {
      out.warnings.push(`Forwarded into the inbox from ${fromEmail}; read as being from ${forwardedFrom.email}.`);
    } else if (direction === 'in' && isOwnAddress(fromEmail)) {
      // Incoming mail from one of our OWN addresses is always a forward, even
      // when it carries no "Fwd:" and no quoted header block — some providers
      // rewrite the sender and leave nothing behind. It is never a customer, so
      // it is never allowed to pass quietly as one.
      out.warnings.push(
        `Arrived from our own ${fromEmail}, so it was forwarded, but the original sender could not be read ` +
        `out of it${looksForwarded(subject, body) ? '' : ' (no forwarded header block in the body)'} — ` +
        `identify the customer on this thread.`
      );
    }
    if (ourRef && !current.order_id && !current.quotation_id) {
      out.warnings.push(`${ourRef.number} is quoted in this mail but no such record exists here.`);
    }

    // Only a thread that has not yet produced a record can be decided by the
    // classifier. Once an order exists, a later mail is an update to it — which
    // is precisely the duplication this whole thing is here to stop.
    const undecided = !current.order_id && !current.quotation_id;

    if (verdict.kind === 'order' && !current.order_id) {
      try {
        const { order, created, warnings } = mintOrder(current, message, actor);
        out.orderNumber = order.order_number;
        out.orderId = order.id;
        out.minted = created;
        out.warnings.push(...warnings);
      } catch (err) {
        out.warnings.push(`Order not created: ${err.message}`);
        db.prepare(`UPDATE mail_threads SET review_reason = ? WHERE id = ?`).run(`order could not be created: ${err.message}`, current.id);
      }
    } else if (verdict.kind === 'inquiry' && undecided) {
      const { quotation, created } = mintQuotation(current, message, actor);
      out.quoteNumber = quotation.quote_number;
      out.quotationId = quotation.id;
      out.minted = created;
    } else if (undecided && verdict.kind === 'ignored' && current.kind === 'unclassified') {
      db.prepare(`UPDATE mail_threads SET kind = 'ignored', decided_by = 'classifier', decided_at = datetime('now') WHERE id = ?`).run(current.id);
    }

    const finished = refreshThread(current.id);
    out.reference = referenceOf(finished);
    out.needsReview = Boolean(finished.needs_review);
    out.reviewReason = finished.review_reason;
    return out;
  })();
}

function cleanAttachment(a) {
  const url = str(a?.url, 2000);
  let safe = null;
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'http:') safe = u.toString();
    } catch { /* not a link we will store */ }
  }
  return { name: str(a?.name, 300) || 'attachment', mimeType: str(a?.mimeType, 120), size: Number(a?.size) || 0, url: safe };
}

/** The id a thread now answers to, which is the point of the whole exercise. */
function referenceOf(t) {
  if (!t) return null;
  if (t.order_id) {
    const o = db.prepare('SELECT order_number FROM orders WHERE id = ?').get(t.order_id);
    return o?.order_number || null;
  }
  if (t.quotation_id) return currentQuotation(t.quotation_id)?.quote_number || null;
  return null;
}

/** A push of many messages: each one stands or falls on its own. */
export function ingestBatch(messages, actor = null) {
  const results = [];
  for (const m of messages) {
    try {
      results.push(ingestMessage(m, actor));
    } catch (err) {
      console.error('[mail] ingest failed:', err.message);
      results.push({ status: 'error', gmailMessageId: m?.gmailMessageId || null, error: err.message });
    }
  }
  return {
    received: messages.length,
    created: results.filter((r) => r.status === 'created').length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
    errors: results.filter((r) => r.status === 'error').length,
    results,
  };
}

// ---------------------------------------------------------------------------
// What a person does with the review queue
// ---------------------------------------------------------------------------

/** The mail a decision should be based on: the first one they actually sent. */
function decidingMessage(threadId) {
  return db.prepare(`SELECT * FROM mail_messages WHERE thread_id = ? AND direction = 'in' ORDER BY sent_at, id LIMIT 1`).get(threadId)
    || db.prepare('SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY sent_at, id LIMIT 1').get(threadId);
}

export function classifyThread(threadId, kind, actor) {
  const thread = threadById(threadId);
  if (!thread) return null;
  if (!['order', 'inquiry', 'ignored'].includes(kind)) throw new Error(`Unknown kind '${kind}'`);

  const message = decidingMessage(threadId);
  if (!message && kind !== 'ignored') throw new Error('This thread has no message to record.');

  if (kind === 'ignored') {
    if (thread.order_id || thread.quotation_id) {
      throw new Error(`${referenceOf(thread)} has already been raised from this thread, so it cannot be set aside.`);
    }
    db.prepare(`UPDATE mail_threads SET kind = 'ignored', decided_by = 'human', decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(threadId);
    return refreshThread(threadId);
  }

  if (kind === 'inquiry' && thread.order_id) {
    throw new Error('This thread already carries an order. Raise the quotation from the order instead.');
  }

  return db.transaction(() => {
    if (kind === 'order') mintOrder(thread, message, actor);
    else mintQuotation(thread, message, actor);
    db.prepare(`UPDATE mail_threads SET decided_by = 'human', decided_at = datetime('now') WHERE id = ?`).run(threadId);
    return refreshThread(threadId);
  })();
}

/** Attach a thread to a record that already exists, instead of minting one. */
export function linkThread(threadId, { orderId = null, quotationId = null }, actor) {
  const thread = threadById(threadId);
  if (!thread) return null;

  if (orderId) {
    const order = db.prepare('SELECT id, order_number FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new Error('No such order');
    const held = threadForOrder(orderId);
    if (held && held.id !== threadId) {
      const merged = mergeThreads(held.id, threadId, `both about ${order.order_number}`);
      if (merged) return merged;
      throw new Error(`${order.order_number} is already attached to another mail thread.`);
    }
    db.prepare(`UPDATE mail_threads SET order_id = ?, kind = 'order', decided_by = 'human', decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(orderId, threadId);
  }
  if (quotationId) {
    const q = db.prepare('SELECT id, quote_number FROM quotations WHERE id = ?').get(quotationId);
    if (!q) throw new Error('No such quotation');
    const held = threadForQuote(quotationId);
    if (held && held.id !== threadId) {
      const merged = mergeThreads(held.id, threadId, `both about ${q.quote_number}`);
      if (merged) return merged;
      throw new Error(`${q.quote_number} is already attached to another mail thread.`);
    }
    db.prepare(`UPDATE mail_threads SET quotation_id = ?, updated_at = datetime('now'),
                kind = CASE WHEN kind = 'unclassified' THEN 'inquiry' ELSE kind END,
                decided_by = 'human', decided_at = datetime('now') WHERE id = ?`).run(quotationId, threadId);
  }
  return refreshThread(threadId);
}

/**
 * Teach the system who a sender is.
 *
 * Binding a domain re-keys every thread from that sender, which can bring two
 * threads onto the same (party, reference) key — they were always the same
 * conversation, we simply could not see it until the sender had a name. Those
 * are merged here rather than being left to collide against the unique index.
 */
export function bindParty({ scope, value, customerName }, actor) {
  if (!['domain', 'address'].includes(scope)) throw new Error(`Unknown scope '${scope}'`);
  const v = String(value || '').trim().toLowerCase();
  if (!v) throw new Error('A domain or address is required');
  if (scope === 'domain' && FREE_MAIL_DOMAINS.has(v)) {
    throw new Error(`${v} is a free mail provider — bind the individual address instead, or thousands of unrelated senders become one customer.`);
  }
  const match = matchCustomer(customerName);
  if (!match.matched) throw new Error(`"${customerName}" is not a customer in Tally.`);

  return db.transaction(() => {
    db.prepare(`INSERT INTO mail_party_map (scope, value, customer_name, customer_guid, created_by)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(scope, value) DO UPDATE SET customer_name = excluded.customer_name,
                  customer_guid = excluded.customer_guid`)
      .run(scope, v, match.name, match.guid, actor?.id || null);

    const newKey = `cust:${match.guid}`;
    const affected = db.prepare(`
      SELECT DISTINCT t.id FROM mail_threads t
      JOIN mail_messages m ON m.thread_id = t.id
      WHERE t.party_key != ? AND ${scope === 'domain' ? "m.from_email LIKE '%@' || ?" : 'm.from_email = ?'}`)
      .all(newKey, v).map((r) => r.id);

    let merged = 0;
    const conflicts = [];
    for (const id of affected) {
      const t = threadById(id);
      if (!t) continue;

      if (t.customer_ref) {
        // Widened past the party key on purpose. A person has just asserted
        // who this sender is, and the question that follows is whether THIS
        // CUSTOMER now holds the same reference twice — which is true even
        // when the other thread is still keyed on a domain, because they wrote
        // from two addresses. The index cannot catch that; only this can.
        const clash = db.prepare(`
          SELECT id FROM mail_threads
          WHERE customer_ref = ? AND id != ? AND (party_key = ? OR customer_guid = ?)
          ORDER BY id LIMIT 1`)
          .get(t.customer_ref, id, newKey, match.guid);
        if (clash && mergeThreads(clash.id, id, 'sender bound to a customer')) { merged++; continue; }
        if (clash) {
          // Both threads already carry a record of their own, so merging them
          // would destroy one. They keep their separate keys — leaving two
          // threads under one key would make which of them a future mail lands
          // on a matter of row order — and both are flagged instead, because
          // one customer holding the same reference twice is a real question
          // for a person and not something to resolve by picking.
          const why = `${match.name} has this reference on more than one thread, each with its own record — left separate for you to decide.`;
          for (const other of [id, clash.id]) {
            db.prepare(`UPDATE mail_threads SET customer_name = ?, customer_guid = ?, needs_review = 1,
                        review_reason = ?, updated_at = datetime('now') WHERE id = ?`)
              .run(match.name, match.guid, why, other);
          }
          conflicts.push({ threads: [id, clash.id], reference: t.customer_ref_raw || t.customer_ref });
          continue;
        }
      }

      db.prepare(`UPDATE mail_threads SET party_key = ?, customer_name = ?, customer_guid = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(newKey, match.name, match.guid, id);
      refreshThread(id);
    }
    return {
      customer: match.name,
      guid: match.guid,
      threadsUpdated: affected.length,
      threadsMerged: merged,
      conflicts,
    };
  })();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function listThreads({ kind = '', search = '', limit = 100 } = {}) {
  const where = [];
  const params = { limit };
  if (kind === 'review') where.push('t.needs_review = 1');
  else if (kind === 'unmatched_party') where.push('t.customer_guid IS NULL AND t.kind != \'ignored\'');
  else if (kind) { where.push('t.kind = @kind'); params.kind = kind; }
  if (search) {
    where.push('(t.subject LIKE @q OR t.customer_name LIKE @q OR t.customer_ref_raw LIKE @q)');
    params.q = `%${search}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT t.*, o.order_number, q.quote_number,
           (SELECT from_email FROM mail_messages m WHERE m.thread_id = t.id ORDER BY m.sent_at, m.id LIMIT 1) AS from_email
    FROM mail_threads t
    LEFT JOIN orders o ON o.id = t.order_id
    LEFT JOIN quotations q ON q.id = t.quotation_id
    ${clause} ORDER BY t.last_message_at DESC, t.id DESC LIMIT @limit`).all(params);
}

export function getThread(id) {
  const t = db.prepare(`
    SELECT t.*, o.order_number, o.status AS order_status
    FROM mail_threads t
    LEFT JOIN orders o ON o.id = t.order_id
    WHERE t.id = ?`).get(id);
  if (!t) return null;
  const q = currentQuotation(t.quotation_id);
  const messages = db.prepare('SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY sent_at, id').all(id)
    .map((m) => ({ ...m, attachments: JSON.parse(m.attachments || '[]') }));
  return {
    ...t,
    // The live version, so the screen never links to a superseded revision.
    quotation_id: q?.id || t.quotation_id,
    quote_number: q?.quote_number || null,
    quote_status: q?.status || null,
    quote_version: q?.version || null,
    messages,
    reference: referenceOf(t),
  };
}

export function mailSummary() {
  const byKind = Object.fromEntries(
    db.prepare('SELECT kind, COUNT(*) AS n FROM mail_threads GROUP BY kind').all().map((r) => [r.kind, r.n])
  );
  return {
    byKind,
    threads: db.prepare('SELECT COUNT(*) AS n FROM mail_threads').get().n,
    messages: db.prepare('SELECT COUNT(*) AS n FROM mail_messages').get().n,
    needsReview: db.prepare('SELECT COUNT(*) AS n FROM mail_threads WHERE needs_review = 1').get().n,
    unmatchedParty: db.prepare(`SELECT COUNT(*) AS n FROM mail_threads WHERE customer_guid IS NULL AND kind != 'ignored'`).get().n,
    lastMessageAt: db.prepare('SELECT MAX(sent_at) AS at FROM mail_messages').get().at,
    lastIngestAt: db.prepare('SELECT MAX(ingested_at) AS at FROM mail_messages').get().at,
  };
}

/** Senders with no ledger behind them, so one binding can clear many threads. */
export function unresolvedSenders(limit = 50) {
  return db.prepare(`
    SELECT m.from_email,
           MAX(m.from_name) AS from_name,
           COUNT(DISTINCT t.id) AS threads,
           MAX(m.sent_at) AS last_at
    FROM mail_threads t JOIN mail_messages m ON m.thread_id = t.id
    WHERE t.customer_guid IS NULL AND t.kind != 'ignored' AND m.direction = 'in' AND m.from_email IS NOT NULL
    GROUP BY m.from_email ORDER BY threads DESC, last_at DESC LIMIT ?`).all(limit);
}
