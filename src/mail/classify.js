/**
 * Reading a mail: what reference does it carry, who sent it, and is it an
 * order or an enquiry.
 *
 * Every function here is pure and deterministic. Given the same message it
 * always answers the same thing, which is what makes a wrong record traceable
 * to a rule instead of to a mood. The classifier deliberately refuses more
 * often than it guesses — an unclassified mail costs someone ten seconds in a
 * review queue, whereas a mail filed as the wrong kind mints a number in the
 * wrong sequence against the wrong customer, and that is found out weeks later
 * by the person chasing a payment.
 */

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

/** Re:, Fwd:, RE :, FW:, [EXTERNAL], stacked as deep as a forwarded chain goes. */
export function cleanSubject(subject) {
  let s = String(subject || '').replace(/\s+/g, ' ').trim();
  for (;;) {
    const next = s
      .replace(/^\s*(re|fw|fwd|aw|antwort|rif|res)\s*[:\-]\s*/i, '')
      .replace(/^\s*\[(external|extern|spam|suspected spam|caution)\]\s*/i, '')
      .trim();
    if (next === s) return s;
    s = next;
  }
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * Our own numbers, in the two shapes they are ever written: BE/SO/2627/0031
 * and BE/Q/2627/0007. Matched case-insensitively and with optional spaces
 * around the slashes, because a customer retyping it will not be careful.
 */
const OUR_REF = /\bBE\s*\/\s*(SO|Q)\s*\/\s*(\d{4})\s*\/\s*(\d{3,6})\b/i;

export function extractOurRef(text) {
  const m = OUR_REF.exec(String(text || ''));
  if (!m) return null;
  const kind = m[1].toUpperCase();
  return { kind: kind === 'SO' ? 'order' : 'quotation', number: `BE/${kind}/${m[2]}/${m[3]}` };
}

/**
 * The customer's own reference, which for us is the thing worth threading on.
 *
 * It is only ever taken from a LABEL followed by a token — "PO No. 4500123456",
 * "RFQ: ABC/25-26/117". A bare number in a subject is not a reference; taking
 * one would merge two unrelated conversations, and a wrong merge is the single
 * worst outcome this feature has, because it hides a real order inside another
 * customer's record where nobody will look for it.
 *
 * Deliberately subject-only. The body of a purchase order mail quotes our
 * quotation number, their old order numbers and an invoice number from last
 * month; picking among those is guesswork, and this does not guess. A reference
 * found only in the body is offered as a suggestion for a person to confirm.
 */
/** A back-reference preposition sitting immediately before a label. */
const BACK_REF_PREFIX =
  /\b(?:against|as\s+per|with\s+reference\s+to|in\s+reference\s+to|wrt|w\.r\.t\.?|vide|further\s+to|referring\s+to)\s+(?:the\s+|your\s+|our\s+|above\s+|attached\s+|said\s+)*$/i;

const REF_LABEL =
  /\b(?:p\.?\s?o\.?|purchase\s*order|work\s*order|w\.?\s?o\.?|order|rfq|r\.?f\.?q\.?|enquiry|inquiry|quotation|quote|ref(?:erence)?|our\s*ref|your\s*ref|indent)\b/gi;

/** Separators between a label and the number: "no.", "#", ":", "-", "is". */
const REF_GAP = /^[\s.:#\-–—]*(?:number|no|num|nos|#|is|:)?[\s.:#\-–—]*/i;

/**
 * A reference token: at least four characters, at least two digits, made only
 * of things a reference is made of. The two-digit floor is what stops "PO for
 * pumps" and "Order status" producing a key.
 */
const REF_TOKEN = /^[A-Za-z0-9][A-Za-z0-9/\\_.-]{2,39}/;

function looksLikeReference(token) {
  const digits = (token.match(/\d/g) || []).length;
  if (token.length < 4 || digits < 2) return false;
  // A date is not a reference. 06/09/2026, 2026-09-06, 06.09.26 all get in
  // under the rule above, and every one of them would key a thread wrongly.
  if (/^\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}$/.test(token)) return false;
  // Neither is a bare year or a plain amount.
  if (/^(19|20)\d{2}$/.test(token)) return false;
  return true;
}

/** Trailing punctuation a sentence leaves on the end of a number. */
const trimToken = (t) => t.replace(/[.,;:)\]}\-/\\]+$/, '');

export function extractCustomerRef(subject) {
  const s = cleanSubject(subject);
  if (!s) return null;

  REF_LABEL.lastIndex = 0;
  let m;
  while ((m = REF_LABEL.exec(s)) !== null) {
    const rest = s.slice(m.index + m[0].length);
    const gap = REF_GAP.exec(rest);
    const after = rest.slice(gap ? gap[0].length : 0);
    const tok = REF_TOKEN.exec(after);
    if (!tok) continue;
    const raw = trimToken(tok[0]);
    if (!looksLikeReference(raw)) continue;
    // Our own number is not "their reference" — it is handled separately, and
    // letting it through here would key their thread on our id.
    if (/^BE[/\\-]/i.test(raw)) continue;
    return {
      raw,
      key: normaliseRef(raw),
      label: m[0].trim(),
      // "Purchase Order against RFQ 887766": the label found is RFQ, but it is
      // pointing back at an enquiry rather than announcing one, so it must not
      // be read as evidence of what this mail is.
      backReference: BACK_REF_PREFIX.test(s.slice(0, m.index)),
    };
  }
  return null;
}

/**
 * The comparable form of a reference.
 *
 * Case and spaces are noise. Separators are NOT: "AB/12/34" and "AB1234" are
 * different numbers, and flattening them would merge two of the same
 * customer's orders. So only case and whitespace are normalised away.
 */
export function normaliseRef(raw) {
  return String(raw || '').toUpperCase().replace(/\s+/g, '').replace(/^[.\-:#]+|[.\-:#]+$/g, '');
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

/**
 * Domains that identify a person, not a company. A thread from one of these
 * keys on the whole address, because half the small suppliers in Indore are on
 * Gmail and keying on the domain would file them all as one customer.
 */
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'rediffmail.com', 'rediff.com', 'sify.com', 'indiatimes.com',
  'aol.com', 'icloud.com', 'me.com', 'protonmail.com', 'proton.me',
  'zoho.com', 'zohomail.com', 'mail.com', 'ymail.com', 'in.com',
]);

export function parseAddress(value) {
  const s = String(value || '').trim();
  if (!s) return { name: null, email: null, domain: null };
  const angled = /^(.*)<\s*([^>]+)\s*>$/.exec(s);
  const email = (angled ? angled[2] : s).trim().toLowerCase();
  let name = angled ? angled[1].trim().replace(/^["']|["']$/g, '').trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { name: name || s, email: null, domain: null };
  if (!name) name = '';
  return { name: name || null, email, domain: email.split('@')[1] || null };
}

// ---------------------------------------------------------------------------
// Forwarded mail
// ---------------------------------------------------------------------------

/**
 * The senders quoted inside a forwarded message.
 *
 * This matters because sales@ is a consolidation inbox: accounts@, the
 * rediffmail account and a personal gmail all feed into it. An automatic
 * forward keeps the customer in the From line, but a forward someone does by
 * hand does not — it arrives from one of OUR OWN addresses, with the real
 * sender buried in the quoted header block.
 *
 * Without this, a hand-forwarded purchase order reads as mail we sent
 * ourselves: logged, never classified, never given a number, and silently
 * absent from the orders list. That is the worst failure available here, so the
 * quoted block is read rather than trusted to be absent.
 *
 * Returns every candidate in order, because the first From: in a chain of
 * forwards can easily be another of our own addresses; the caller drops those.
 */
const FORWARD_FROM = /^\s*(?:>\s*)*(?:from|de|von)\s*:\s*(.+)$/gim;

export function extractForwardedSenders(body, limit = 5) {
  const text = String(body || '').slice(0, 8000);
  const out = [];
  FORWARD_FROM.lastIndex = 0;
  let m;
  while ((m = FORWARD_FROM.exec(text)) !== null && out.length < limit) {
    const parsed = parseAddress(m[1].trim());
    if (parsed.email && !out.some((p) => p.email === parsed.email)) out.push(parsed);
  }
  return out;
}

/** Does this read as a forward at all? Used only to explain a decision. */
export const looksForwarded = (subject, body) =>
  /^\s*(fw|fwd)\s*[:\-]/i.test(String(subject || '')) ||
  /-{2,}\s*(forwarded message|original message)\s*-{2,}/i.test(String(body || '').slice(0, 8000));

// ---------------------------------------------------------------------------
// Mail we should not act on at all
// ---------------------------------------------------------------------------

// Local parts that never belong to a person asking us for a price. "info@" is
// deliberately absent: it is a perfectly ordinary purchasing address for a
// small firm here, and blocking it would lose real enquiries.
const NOISE_SENDER =
  /^(mailer-daemon|postmaster|no-?reply|noreply|donotreply|do-not-reply|bounce|notifications?|newsletter|news|marketing|promo(tions?)?|offers?|deals|campaign|mailer|updates?|digest|info-noreply)@/i;
const NOISE_SUBJECT =
  /^(automatic reply|auto[- ]?reply|out of office|undeliverable|delivery status notification|mail delivery|returned mail|read receipt|your message to)/i;

/**
 * Auto-replies, bounces and bulk mail. Recorded with a reason rather than
 * dropped — "we never got your enquiry" is a conversation that goes better
 * when the out-of-office that swallowed it is still on file.
 */
export function isNoise({ fromEmail, subject, headers = {} }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (h['list-unsubscribe'] || h['list-id']) return 'bulk mail (carries a List-Unsubscribe header)';
  if (h['auto-submitted'] && !/^no$/i.test(String(h['auto-submitted']))) return 'auto-submitted mail';
  if (h['x-autoreply'] || h['x-autorespond']) return 'auto-responder';
  if (fromEmail && NOISE_SENDER.test(fromEmail)) return `no-reply or system sender (${fromEmail})`;
  if (subject && NOISE_SUBJECT.test(cleanSubject(subject))) return 'auto-reply or bounce subject';
  return null;
}

// ---------------------------------------------------------------------------
// Order or enquiry
// ---------------------------------------------------------------------------

/**
 * Weighted phrases. A subject hit counts double: what a mail is about is said
 * in the subject, whereas a body quotes the last four mails underneath it.
 */
const ORDER_RULES = [
  [/\bpurchase\s*order\b/i, 3, 'says "purchase order"'],
  [/\bp\.?\s?o\.?\s*(?:no|number|num|#)\b/i, 3, 'gives a PO number'],
  [/\bwork\s*order\b/i, 3, 'says "work order"'],
  [/\border\s+confirmation\b/i, 3, 'order confirmation'],
  [/\b(?:placing|placed|place)\s+(?:an?\s+|our\s+|the\s+)?order\b/i, 3, 'places an order'],
  [/\bkindly\s+(?:supply|deliver|dispatch|despatch|execute)\b/i, 2, 'asks us to supply'],
  [/\bagainst\s+(?:our|this)\s+(?:p\.?o\.?|purchase\s*order|order)\b/i, 2, 'refers to their own PO'],
  [/\bindent\b/i, 2, 'says "indent"'],
  [/\bdelivery\s+schedule\b/i, 1, 'delivery schedule'],
];

const INQUIRY_RULES = [
  [/\b(?:enquiry|inquiry|enquiries|inquiries)\b/i, 3, 'says "enquiry"'],
  [/\brequest\s+for\s+quotation\b/i, 3, 'request for quotation'],
  [/\brfq\b/i, 3, 'says "RFQ"'],
  [/\b(?:kindly|please|pls|requested?\s+to|request\s+you\s+to)\s+(?:quote|offer|re-?quote)\b/i, 3, 'asks us to quote'],
  [/\b(?:send|share|provide)\s+(?:us\s+)?(?:your\s+)?(?:best\s+)?(?:rates?|prices?|quotation|quote|offer)\b/i, 3, 'asks for rates'],
  [/\b(?:quotation|quote)\b/i, 2, 'says "quotation"'],
  [/\bproforma\b/i, 2, 'asks for a proforma'],
  [/\b(?:price|rate)\s+list\b/i, 2, 'asks for a price list'],
  [/\bavailability\b/i, 1, 'asks about availability'],
  [/\blead\s*time\b/i, 1, 'asks about lead time'],
  // Phrasings taken from the keyword list already in use on the live mailbox.
  // These are what their customers actually write, and no general vocabulary
  // would have guessed them.
  [/\bno\s*regret\s*offer\b/i, 3, 'asks for a no-regret offer'],
  [/\brequirement\s+of\s+(?:the\s+)?mentioned\s+item/i, 3, 'states a requirement'],
  [/\bquotation\s+required\b/i, 3, 'quotation required'],
  [/\bquote\s+required\b/i, 3, 'quote required'],
];

/**
 * Enquiry words pointing BACKWARDS at an enquiry we already have, rather than
 * making a new one. "Purchase order against RFQ 887766" is an order, and so is
 * "kindly supply as per your quotation" — but left as they stand, both read as
 * half an enquiry as well, and a purchase order that reads as half an enquiry
 * is precisely the mail that ends up filed as neither.
 *
 * Only the enquiry vocabulary is neutralised this way, which is not an
 * oversight: a mail referring back to an ENQUIRY is the order for it, and a
 * mail referring back to an ORDER is about that order. Both are orders, so
 * only one direction of this needs cancelling out.
 */
const BACK_REFERENCE =
  /\b(?:against|as\s+per|with\s+reference\s+to|in\s+reference\s+to|wrt|w\.r\.t\.?|vide|further\s+to|referring\s+to|ref(?:erence)?\s*[:.]?)\s+(?:the\s+|your\s+|our\s+|above\s+|attached\s+|said\s+)*(?:rfq|enquiry|inquiry|quotation|quote|offer|proforma)\b/gi;

const withoutBackReferences = (text) => String(text || '').replace(BACK_REFERENCE, ' ');

/**
 * The label a validated reference was written under. This is the strongest
 * cheap signal there is, and worth its own rule: a subject reading "PO 887766"
 * says nothing else at all, yet the extractor has already proved that "PO" is
 * introducing a real reference rather than appearing in a sentence. Quotation
 * and bare "Ref" are deliberately absent — a purchase order quotes our
 * quotation number as often as an enquiry asks for one.
 */
const LABEL_SIDE = [
  [/^(?:p\.?\s?o\.?|purchase\s*order|work\s*order|w\.?\s?o\.?|order|indent)$/i, 'order'],
  [/^(?:rfq|r\.?f\.?q\.?|enquiry|inquiry)$/i, 'inquiry'],
];

const ATTACHMENT_ORDER = /\b(po|p_o|purchase[-_ ]?order|work[-_ ]?order|wo)\b/i;
const ATTACHMENT_INQUIRY = /\b(rfq|enquiry|inquiry|requirement)\b/i;

/** A mail must beat this to be filed at all, and beat the loser by this much. */
export const CLASSIFY_FLOOR = 3;
export const CLASSIFY_MARGIN = 2;

function score(rules, subject, body) {
  let total = 0;
  const why = [];
  for (const [re, weight, label] of rules) {
    if (re.test(subject)) {
      total += weight * 2;
      why.push(`subject ${label}`);
    } else if (re.test(body)) {
      total += weight;
      why.push(label);
    }
  }
  return { total, why };
}

/**
 * Which of the two this is, or neither.
 *
 * Refusing is a legitimate answer and the common one for a mail that says
 * "please send your best rates against our PO 4471" — which is genuinely both
 * until a person looks at the attachment.
 */
export function classify({ subject, body, attachments = [], direction = 'in', ref = null }) {
  // Our own mail joins the conversation but never starts a record. A quotation
  // we sent contains every enquiry phrase there is.
  if (direction === 'out') {
    return { kind: 'ignored', orderScore: 0, inquiryScore: 0, reason: 'our own outgoing mail' };
  }

  const s = cleanSubject(subject);
  const b = String(body || '').slice(0, 20000);

  const order = score(ORDER_RULES, s, b);
  const inquiry = score(INQUIRY_RULES, withoutBackReferences(s), withoutBackReferences(b));

  if (ref && !ref.backReference) {
    for (const [re, side] of LABEL_SIDE) {
      if (!re.test(ref.label)) continue;
      const bucket = side === 'order' ? order : inquiry;
      bucket.total += 3;
      bucket.why.push(`subject gives ${ref.label} ${ref.raw}`);
      break;
    }
  }

  for (const a of attachments) {
    const name = String(a?.name || '');
    if (ATTACHMENT_ORDER.test(name)) {
      order.total += 2;
      order.why.push(`attachment named ${name}`);
    }
    if (ATTACHMENT_INQUIRY.test(name)) {
      inquiry.total += 2;
      inquiry.why.push(`attachment named ${name}`);
    }
  }

  const out = { orderScore: order.total, inquiryScore: inquiry.total };
  const top = Math.max(order.total, inquiry.total);

  if (top < CLASSIFY_FLOOR) {
    return { ...out, kind: 'unclassified', reason: 'nothing in it says order or enquiry' };
  }
  if (Math.abs(order.total - inquiry.total) < CLASSIFY_MARGIN) {
    return {
      ...out,
      kind: 'unclassified',
      reason: `reads as both (order ${order.total} vs enquiry ${inquiry.total}) — ${[...order.why, ...inquiry.why].slice(0, 4).join('; ')}`,
    };
  }
  const isOrder = order.total > inquiry.total;
  return {
    ...out,
    kind: isOrder ? 'order' : 'inquiry',
    reason: (isOrder ? order.why : inquiry.why).slice(0, 3).join('; '),
  };
}
