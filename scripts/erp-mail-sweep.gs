/**
 * BALAJI ENTERPRISES — GMAIL → ERP
 * ============================================================================
 * Install inside sales@rbalajient.com. That is the consolidation inbox:
 * accounts@, the rediffmail account and the personal gmail all forward into it,
 * and this script only ever reads the account it is installed under.
 *
 * WHAT IT DOES
 *   Sweeps Gmail every 10 minutes -> saves PDFs to Drive -> hands each message
 *   to the ERP -> writes the ERP's answer into the sheet.
 *
 * WHAT IT DOES NOT DO
 *   Decide anything. The ERP threads the mail, decides order or enquiry, and
 *   mints the BE/SO or BE/Q number. This script transports and records.
 *   Classification rules must hold identically for a mail arriving today and
 *   the same mail re-swept next month, and rules living in two places do not
 *   stay identical. The keyword lists survive only as a "Script Guess" column
 *   next to the ERP's verdict, so a drift between them is visible.
 *
 * THE SHEET IS A MAIL LOG, NOT AN ORDER LIST
 *   One row per mail. Several mails about one purchase order all carry its
 *   BE/SO number; exactly one of them says "raised" in the ERP Action column
 *   and the rest say "joined". That is what makes the sheet reconcile against
 *   the ERP instead of merely resembling it.
 *
 * SETUP — see docs/gmail-mail-ingest.md. Short version:
 *   0. Be logged into sales@rbalajient.com in the browser first.
 *   1. Paste this file in, set ERP_URL and SHEET_ID below.
 *   2. Project Settings -> Script Properties -> ERP_INGEST_TOKEN = <the token>.
 *   3. Editor -> Services -> add "Gmail API".
 *   4. Run setup() and read the log. It refuses to say "ready" until it is.
 */

// ============================================================================
// CONFIG
// ============================================================================
// Constants keep a prefix because Apps Script shares one global scope across
// every file in a project, so a duplicate top-level name anywhere in the
// project throws "Identifier already declared" — including from a file added
// months from now.

/**
 * Where the ERP is reachable FROM GOOGLE'S SERVERS.
 *
 * This is the one value still to fill in. localhost cannot work — Apps Script
 * runs on Google's machines, not yours — and UrlFetchApp refuses plain http,
 * so it has to be an https name that resolves publicly. A Cloudflare Tunnel is
 * free and the least painful way to get one.
 */
const ERP_URL = 'https://your-erp-host';

/** The new spreadsheet's id — the long string in its URL between /d/ and /edit. */
const ERP_SHEET_ID = '1suCLX3dVZfcM2KIXUXpwMIWZ4N9CiU74JiaQgvGv8sY';

const ERP_TAB_ORDERS = 'Order Log';
const ERP_TAB_INQUIRIES = 'Inquiry Log';
const ERP_TAB_REVIEW = 'Needs Review';

const ERP_DRIVE_FOLDER = 'Balaji ERP - Mail Attachments';
/**
 * This script's labels. Nothing to do with the old script's "Logged" — that one
 * stays exactly as it is, on the same threads, still meaning what it meant.
 *
 * These are only markers for you to read in Gmail. Dedupe is by Gmail message
 * id read back from the sheet, never by a label, so renaming these breaks
 * nothing.
 */
const ERP_LABEL_SYNCED = 'ERP';
const ERP_LABEL_FAILED = 'ERP Failed';

/**
 * The old script's label. Read only — nothing here ever adds or removes it.
 * Used by importOldLabelled() to find the mail that script already handled.
 */
const ERP_OLD_LABEL = 'Logged';

/**
 * What to sweep.
 *
 * Deliberately NOT has:attachment. Most enquiries are plain text — "kindly
 * quote for the below items" — and an attachment filter never sees one of them.
 * Sent mail is included so our own replies sit on the same thread as the
 * customer's; the ERP logs those and never classifies them.
 */
const ERP_SEARCH = '(in:inbox OR in:sent) -in:chats -in:drafts -category:promotions -category:social';

/** How far the first run reaches back. After that a watermark takes over. */
const ERP_BACKFILL_DAYS = 7;

/**
 * Gmail's search caps at 500 results. 400 leaves headroom and is far more than
 * a ten-minute window will ever hold — the number only really matters on the
 * very first run, which reaches back a week in one go.
 */
const ERP_MAX_THREADS_PER_RUN = 400;
const ERP_BATCH_SIZE = 50;
const ERP_MAX_PDF_BYTES = 15 * 1024 * 1024;

/** A first guess, shown beside the ERP's verdict. Not used to route anything. */
const ERP_ORDER_WORDS = ['purchase order', 'p.o.', ' po ', 'po no', 'po#', 'order confirmation', 'work order'];
const ERP_INQUIRY_WORDS = ['rfq', 'quotation required', 'inquiry', 'enquiry', 'request for quotation',
  'quote required', 'kindly quote', 'please quote', 'no regret offer', 'requirement of mentioned item'];

// ============================================================================

const ERP_PROPS = PropertiesService.getScriptProperties();

const ERP_BASE_COLUMNS = ['Date Received', 'From', 'Originally Sent To', 'Subject',
  'Attachment(s)', 'Drive Link(s)'];
const ERP_SYNC_COLUMNS = ['Gmail Message ID', 'ERP Reference', 'ERP Verdict', 'ERP Action',
  'Script Guess', 'Synced At'];


// ============================================================================
// Entry points — the only four functions to run by hand
// ============================================================================

/**
 * Run once, by hand. Checks every prerequisite and says plainly which are
 * missing, rather than installing a trigger that fails quietly at 3am.
 */
function setup() {
  const blockers = [];

  if (ERP_SHEET_ID.indexOf('PASTE') === 0) blockers.push('ERP_SHEET_ID is still the placeholder.');
  if (ERP_URL.indexOf('your-erp-host') !== -1) blockers.push('ERP_URL is still the placeholder.');
  if (ERP_URL.indexOf('https://') !== 0) blockers.push('ERP_URL must be https — Apps Script will not post to plain http.');

  if (!ERP_PROPS.getProperty('ERP_INGEST_TOKEN')) {
    blockers.push('ERP_INGEST_TOKEN is not set. Project Settings -> Script Properties -> add it.');
  } else if (!blockers.length) {
    const ping = erpRequest_('GET', '/api/ingest/ping');
    if (ping.ok) Logger.log('ERP reachable at %s', ERP_URL);
    else blockers.push('The ERP did not answer: HTTP ' + ping.code + ' ' + JSON.stringify(ping.body));
  }

  if (gmailApiEnabled_()) {
    Logger.log('Gmail API service is on — newsletters and auto-replies will be caught by their headers.');
  } else {
    blockers.push('The Gmail API service is off. Editor -> Services -> add "Gmail API". Without it a '
      + 'marketing mail reading "best rates, request your quotation today" reads as a customer enquiry.');
  }

  driveFolder_();
  gmailLabel_(ERP_LABEL_SYNCED);
  gmailLabel_(ERP_LABEL_FAILED);

  // Print what is actually in the mailbox, so ERP_OLD_LABEL can be set from
  // fact rather than from memory of what the old script was configured with.
  if (ERP_OLD_LABEL === ERP_LABEL_SYNCED || ERP_OLD_LABEL === ERP_LABEL_FAILED) {
    blockers.push('ERP_OLD_LABEL is set to one of this script\'s own labels. The historical import '
      + 'would then read its own output and never finish. Set it to the OLD script\'s label.');
  }

  const labels = GmailApp.getUserLabels().map(function (l) { return l.getName(); });
  Logger.log('Labels in this account: %s', labels.join(', ') || '(none)');
  if (labels.indexOf(ERP_OLD_LABEL) === -1) {
    Logger.log('NOTE: no label called "%s". If you want the old script\'s history imported, set '
      + 'ERP_OLD_LABEL to the right name from the list above, then run importOldLabelled().', ERP_OLD_LABEL);
  } else {
    const n = GmailApp.search('label:' + ERP_OLD_LABEL.split('/').join('-'), 0, 500).length;
    Logger.log('Found "%s" on %s%s threads. Run importOldLabelled() to pull that history into the ERP.',
      ERP_OLD_LABEL, n >= 500 ? '500+' : n, '');
  }

  if (ERP_SHEET_ID.indexOf('PASTE') !== 0) {
    const book = SpreadsheetApp.openById(ERP_SHEET_ID);
    orderLog_(book);
    inquiryLog_(book);
    reviewLog_(book);
    Logger.log('Sheet: %s', book.getUrl());
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sweepMailbox') return;
    blockers.push('A trigger on ' + t.getHandlerFunction() + ' is still installed. Delete it, or both '
      + 'run and every row lands in the sheet twice.');
  });

  // Always start from no sweep trigger. If anything below is unresolved there
  // must not be one left running, and if everything is resolved a fresh one is
  // installed — either way this is the only place that decides.
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sweepMailbox'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  if (blockers.length) {
    // THROWN, not logged.
    //
    // The first version of this only wrote the problems to the log and
    // installed the trigger regardless — so an entirely unconfigured setup
    // finished with no error on screen, looked successful, and left a job
    // firing every ten minutes at a placeholder URL. A check nobody is made to
    // read is not a check.
    Logger.log('\n--- NOT READY ---');
    blockers.forEach(function (b) { Logger.log('  * ' + b); });
    Logger.log('\nNo trigger is installed. Fix the above and run setup() again.');
    throw new Error('Setup incomplete — ' + blockers.length + ' thing(s) to fix:\n  * '
      + blockers.join('\n  * ') + '\n\nNo trigger installed. Fix these and run setup() again.');
  }

  ScriptApp.newTrigger('sweepMailbox').timeBased().everyMinutes(10).create();
  Logger.log('\nREADY. Trigger installed, running every 10 minutes. '
    + 'The first sweep covers the last %s days.', ERP_BACKFILL_DAYS);
}

/** The scheduled job. One at a time, always. */
function sweepMailbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Another sweep is still running; skipping this one.');
    return;
  }
  try {
    runSweep_();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Re-read the mailbox from scratch.
 *
 * Safe at any time. The ERP answers "duplicate" for everything it already
 * holds and the sheet is keyed on the Gmail message id, so this picks up only
 * what was missed. Use it after changing a classification rule.
 */
function resetSync() {
  ERP_PROPS.deleteProperty('watermark');
  [ERP_LABEL_SYNCED, ERP_LABEL_FAILED].forEach(function (name) {
    const label = GmailApp.getUserLabelByName(name);
    if (label) label.getThreads(0, 200).forEach(function (t) { t.removeLabel(label); });
  });
  Logger.log('Watermark cleared. The next sweep starts %s days back.', ERP_BACKFILL_DAYS);
}

/**
 * One-off: pull the history the OLD script already marked into the ERP.
 *
 * The old label is the only record of which mail that script ever saw, and
 * that set is worth having: those purchase orders become real orders with real
 * BE/SO numbers instead of rows in a spreadsheet nothing can reconcile.
 *
 * READ THIS BEFORE RUNNING IT. Every purchase order it finds becomes an order
 * in the ERP with its own number, and every enquiry becomes a draft quotation.
 * If the old label covers two years of mail, you get two years of orders — all
 * of them with no line items, because the items are inside the PDFs. That may
 * be exactly the history you want, or it may bury the twelve orders that are
 * actually live. Decide first; there is no undo short of resetting the ERP's
 * database.
 *
 * Run it repeatedly. It pages through the labelled threads, remembering where
 * it stopped, so it survives the six-minute execution limit; each run reports
 * how far it got. When it says the label is exhausted, it is done.
 *
 * It never touches the live sweep's watermark, so ordinary mail keeps flowing
 * the whole time.
 */
function importOldLabelled() {
  const query = 'label:' + ERP_OLD_LABEL.split('/').join('-');
  const probe = GmailApp.search(query, 0, 1);
  if (!probe.length) {
    Logger.log('No threads carry "%s". Run setup() to see the labels this account actually has.', ERP_OLD_LABEL);
    return;
  }

  const offset = Number(ERP_PROPS.getProperty('oldImportOffset')) || 0;
  // A page at a time. The result set is stable because nothing here removes the
  // old label, so the offset keeps meaning the same thing between runs.
  const page = 100;
  const threads = GmailApp.search(query, offset, page);
  if (!threads.length) {
    Logger.log('Finished: every thread under "%s" has been offered to the ERP. '
      + 'Run forgetOldImport() if you ever want to start the import again.', ERP_OLD_LABEL);
    return;
  }

  const book = SpreadsheetApp.openById(ERP_SHEET_ID);
  const tabs = { orders: orderLog_(book), inquiries: inquiryLog_(book), review: reviewLog_(book) };
  const alreadyLogged = loggedMessageIds_(tabs);
  const folder = driveFolder_();

  // Every message on these threads, however old — the label IS the selection,
  // so the live sweep's date window does not apply. The sent-map reaches back a
  // year; anything older that misses it is read as incoming, and the ERP
  // refuses to raise a record from mail that appears to come from us, so a
  // miss costs a review-queue row rather than a wrong order.
  const sent = sentMessageIds_(Date.now() - 400 * 86400000);

  const pending = [];
  GmailApp.getMessagesForThreads(threads).forEach(function (messages, i) {
    messages.forEach(function (message) {
      if (alreadyLogged[message.getId()]) return;
      pending.push(collectMessage_(message, threads[i], folder, sent));
    });
  });

  if (!pending.length) {
    ERP_PROPS.setProperty('oldImportOffset', String(offset + threads.length));
    Logger.log('Threads %s-%s: nothing new. Run importOldLabelled() again for the next page.',
      offset + 1, offset + threads.length);
    return;
  }

  const tally = pushAndRecord_(pending, tabs);

  // Only advance the page when the ERP actually took the batch, so an outage
  // cannot skip a hundred threads.
  if (!tally.undelivered) {
    ERP_PROPS.setProperty('oldImportOffset', String(offset + threads.length));
  }

  Logger.log('Threads %s-%s of "%s": %s messages — %s raised, %s joined, %s already held, '
    + '%s rejected, %s not delivered.%s',
    offset + 1, offset + threads.length, ERP_OLD_LABEL, pending.length,
    tally.raised, tally.joined, tally.duplicate, tally.rejected, tally.undelivered,
    tally.undelivered ? ' Page NOT advanced — run it again once the ERP is reachable.'
      : ' Run importOldLabelled() again for the next page.');
}

/** Forget how far the historical import got, so it starts from the beginning. */
function forgetOldImport() {
  ERP_PROPS.deleteProperty('oldImportOffset');
  Logger.log('Historical import will restart from the first thread. Nothing is duplicated: the ERP '
    + 'answers "duplicate" for every message it already holds.');
}

/** Stop sweeping. Mail, labels and sheet all stay exactly as they are. */
function stopSweeping() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'sweepMailbox'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('Trigger removed.');
}


// ============================================================================
// The sweep
// ============================================================================

function runSweep_() {
  const since = Number(ERP_PROPS.getProperty('watermark')) || (Date.now() - ERP_BACKFILL_DAYS * 86400000);

  // One second of overlap on purpose. Missing a mail is expensive; sending one
  // twice costs nothing, because the ERP and the sheet both key on message id.
  const threads = GmailApp.search(ERP_SEARCH + ' after:' + (Math.floor(since / 1000) - 1), 0, ERP_MAX_THREADS_PER_RUN);
  if (!threads.length) {
    Logger.log('Nothing new.');
    return;
  }

  const book = SpreadsheetApp.openById(ERP_SHEET_ID);
  const tabs = { orders: orderLog_(book), inquiries: inquiryLog_(book), review: reviewLog_(book) };

  // The dedupe key is the Gmail MESSAGE id, read back out of the sheet.
  //
  // It cannot be a label. GmailApp can only label a THREAD, so labelling after
  // logging one message would hide every later message in that conversation —
  // and an enquiry followed weeks later by its purchase order, on the same
  // thread, is the commonest shape of mail this business gets. Labelling that
  // thread would lose the order outright.
  const alreadyLogged = loggedMessageIds_(tabs);
  const sent = sentMessageIds_(since);
  const folder = driveFolder_();

  const pending = [];
  let newest = since;

  GmailApp.getMessagesForThreads(threads).forEach(function (messages, i) {
    messages.forEach(function (message) {
      const at = message.getDate().getTime();
      if (at < since) return;                        // older part of a live thread
      if (at > newest) newest = at;
      if (alreadyLogged[message.getId()]) return;
      pending.push(collectMessage_(message, threads[i], folder, sent));
    });
  });

  if (threads.length >= ERP_MAX_THREADS_PER_RUN) {
    // Gmail returns the NEWEST results first, so a truncated window means the
    // OLDER mail in it was never seen — and the watermark is about to move past
    // it. Only reachable on a first backfill; say so loudly rather than let a
    // week of mail disappear quietly.
    Logger.log('WARNING: the search filled its %s-thread limit, so older mail in this window was not '
      + 'read and the watermark is about to move past it. Lower ERP_BACKFILL_DAYS, run resetSync(), '
      + 'and let it catch up in smaller steps.', ERP_MAX_THREADS_PER_RUN);
  }

  if (!pending.length) {
    // The watermark still moves. Without this the sweep can wedge: a window
    // whose every message is already logged would return here forever, re-read
    // the same threads every ten minutes, and never advance.
    ERP_PROPS.setProperty('watermark', String(newest));
    Logger.log('%s threads matched; every message in them was already logged.', threads.length);
    return;
  }

  const tally = pushAndRecord_(pending, tabs);

  // Moved past everything the ERP answered for. A message it rejected has been
  // recorded and labelled, so it is dealt with; only mail the ERP never saw
  // holds the clock back.
  if (!tally.undelivered) ERP_PROPS.setProperty('watermark', String(newest));

  Logger.log('%s messages — %s records raised, %s joined an existing record, %s already held, '
    + '%s rejected, %s not delivered%s',
    pending.length, tally.raised, tally.joined, tally.duplicate, tally.rejected, tally.undelivered,
    tally.undelivered ? ' (watermark held back; this window will be retried)' : '');
}


/**
 * Hand a collected batch to the ERP and write down what it says.
 *
 * Shared by the live sweep and the one-off historical import, deliberately:
 * a mail imported from the old label must land in the ERP by exactly the same
 * route as one arriving this morning, or the two sets of records would not be
 * comparable.
 */
function pushAndRecord_(pending, tabs) {
  const tally = { raised: 0, joined: 0, duplicate: 0, rejected: 0, undelivered: 0 };
  const logged = gmailLabel_(ERP_LABEL_SYNCED);
  const failed = gmailLabel_(ERP_LABEL_FAILED);

  for (var i = 0; i < pending.length; i += ERP_BATCH_SIZE) {
    const batch = pending.slice(i, i + ERP_BATCH_SIZE);
    const response = erpRequest_('POST', '/api/ingest/mail', {
      messages: batch.map(function (item) { return item.payload; }),
    });

    if (!response.ok) {
      // Nothing was recorded: bad token, ERP down, bad deploy. Nothing goes in
      // the sheet and the watermark does not move, so this same window is swept
      // again next time.
      Logger.log('ERP unreachable for %s messages (HTTP %s): %s',
        batch.length, response.code, JSON.stringify(response.body).slice(0, 400));
      tally.undelivered += batch.length;
      continue;
    }

    const answers = {};
    (response.body.results || []).forEach(function (r) { answers[r.gmailMessageId] = r; });

    batch.forEach(function (item) {
      const answer = answers[item.payload.gmailMessageId];
      if (!answer || answer.status === 'error') {
        tally.rejected++;
        item.thread.addLabel(failed);
        Logger.log('Rejected %s: %s', item.payload.gmailMessageId, (answer && answer.error) || 'no result returned');
        return;
      }

      if (answer.status === 'duplicate') tally.duplicate++;
      else if (answer.minted) tally.raised++;
      else tally.joined++;

      recordResult_(tabs, item, answer);
      item.thread.addLabel(logged);
      item.thread.removeLabel(failed);

      if (answer.warnings && answer.warnings.length) {
        Logger.log('%s — %s', answer.reference || item.payload.gmailMessageId, answer.warnings.join(' | '));
      }
    });
  }

  return tally;
}


// ============================================================================
// One message
// ============================================================================

function collectMessage_(message, thread, folder, sentIds) {
  const receivedAt = message.getDate();
  const body = message.getPlainBody().slice(0, 20000);
  const headers = messageHeaders_(message.getId());
  const saved = saveAttachments_(message, folder, receivedAt);
  const guess = keywordGuess_(message.getSubject() + ' ' + body.slice(0, 1500));

  return {
    thread: thread,
    receivedAt: receivedAt,
    from: message.getFrom(),
    to: message.getTo(),
    subject: message.getSubject(),
    fileNames: saved.names,
    driveLinks: saved.links,
    guess: guess,
    payload: {
      gmailMessageId: message.getId(),
      gmailThreadId: thread.getId(),
      rfcMessageId: headers['Message-ID'] || '',
      // Gmail's own answer to "did we send this", which beats inferring it from
      // the domain: sales@ receives forwards from our own addresses all day,
      // and reading those as outgoing would bury every forwarded order.
      folder: sentIds[message.getId()] ? 'sent' : 'inbox',
      from: message.getFrom(),
      to: message.getTo(),
      cc: message.getCc(),
      subject: message.getSubject(),
      bodyText: body,
      snippet: body.slice(0, 300),
      sentAt: receivedAt.toISOString(),
      permalink: 'https://mail.google.com/mail/u/0/#all/' + thread.getId(),
      attachments: saved.attachments,
      headers: headers,
      verdict: guess === 'ORDER' ? 'order' : guess === 'INQUIRY' ? 'inquiry' : '',
    },
  };
}

/** PDFs go to Drive; everything else is recorded by name only. */
function saveAttachments_(message, folder, receivedAt) {
  const names = [];
  const links = [];
  const attachments = [];

  message.getAttachments({ includeInlineImages: false, includeAttachments: true }).forEach(function (att) {
    const entry = { name: att.getName(), mimeType: att.getContentType(), size: att.getSize() };
    names.push(att.getName());

    if (att.getContentType() === 'application/pdf' && att.getSize() <= ERP_MAX_PDF_BYTES) {
      try {
        const stamped = Utilities.formatDate(receivedAt, Session.getScriptTimeZone(), 'yyyy-MM-dd')
          + ' - ' + sanitiseFileName_(att.getName());
        const file = folder.createFile(att.copyBlob()).setName(stamped);
        entry.url = file.getUrl();
        links.push(file.getUrl());
      } catch (e) {
        Logger.log('Could not save %s: %s', att.getName(), e.message);
      }
    }
    attachments.push(entry);
  });

  return { names: names, links: links, attachments: attachments };
}

/**
 * Headers, through the Gmail API service — GmailApp cannot read them at all,
 * there is no getHeader() on a message. Metadata format only, so this fetches
 * no body and no attachments.
 */
function messageHeaders_(messageId) {
  if (!messageHeaders_.available) return {};
  try {
    const meta = Gmail.Users.Messages.get('me', messageId, {
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'List-Unsubscribe', 'List-Id', 'Auto-Submitted', 'X-Autoreply'],
    });
    const out = {};
    ((meta.payload && meta.payload.headers) || []).forEach(function (h) { out[h.name] = h.value; });
    return out;
  } catch (e) {
    Logger.log('Gmail API service unavailable (%s) — falling back to sender and subject checks.', e.message);
    messageHeaders_.available = false;
    return {};
  }
}
messageHeaders_.available = true;

function gmailApiEnabled_() {
  try {
    return typeof Gmail !== 'undefined' && Boolean(Gmail.Users);
  } catch (e) {
    return false;
  }
}

/** Which message ids are in Sent, so direction is a fact and not a guess. */
function sentMessageIds_(since) {
  const out = {};
  // Deliberately its own, larger cap. A message missing from this map is read
  // as incoming, and our own reply read as incoming is a quotation email that
  // looks exactly like a customer enquiry.
  const threads = GmailApp.search('in:sent after:' + (Math.floor(since / 1000) - 1), 0, 500);
  GmailApp.getMessagesForThreads(threads).forEach(function (messages) {
    messages.forEach(function (m) { out[m.getId()] = true; });
  });
  return out;
}

/** A first guess only. The ERP's verdict is what routes the row. */
function keywordGuess_(text) {
  const lower = String(text || '').toLowerCase();
  const order = ERP_ORDER_WORDS.some(function (w) { return lower.indexOf(w) !== -1; });
  const inquiry = ERP_INQUIRY_WORDS.some(function (w) { return lower.indexOf(w) !== -1; });
  if (order && !inquiry) return 'ORDER';
  if (inquiry && !order) return 'INQUIRY';
  if (order && inquiry) return 'BOTH';
  return 'NEITHER';
}


// ============================================================================
// The sheet
// ============================================================================

/**
 * Write the ERP's answer into whichever tab the ERP's verdict says.
 *
 * Mail the ERP set aside — our own replies, out-of-office, newsletters — gets
 * no row. It is on the thread inside the ERP where it belongs; in the sheet it
 * would only bury the rows somebody has to act on.
 */
function recordResult_(tabs, item, answer) {
  const verdict = answer.classifiedAs || 'unclassified';
  if (verdict === 'ignored') return;

  const action = answer.status === 'duplicate' ? 'already logged'
    : answer.minted ? 'raised' : 'joined';

  const base = [
    item.receivedAt,
    item.from,
    item.to,
    item.subject,
    item.fileNames.join(', '),
    item.driveLinks.join('\n'),
  ];
  const sync = [
    item.payload.gmailMessageId,
    answer.reference || '',
    verdict,
    action,
    item.guess,
    new Date(),
  ];

  if (verdict === 'order') {
    tabs.orders.appendRow(base.concat([answer.needsReview ? 'Needs Review' : 'New'], sync));
  } else if (verdict === 'inquiry') {
    tabs.inquiries.appendRow(base.concat(sync));
  } else {
    tabs.review.appendRow(base.concat([answer.reviewReason || answer.reason || ''], sync));
  }
}

/**
 * Every Gmail message id already written to any tab.
 *
 * Read once per sweep rather than searched per message: one getRange beats a
 * thousand, and the sheet is the durable record of what has been logged, so it
 * stays correct even if a label is deleted by hand.
 */
function loggedMessageIds_(tabs) {
  const seen = {};
  [tabs.orders, tabs.inquiries, tabs.review].forEach(function (sheet) {
    const column = columnNumber_(sheet, 'Gmail Message ID');
    const lastRow = sheet.getLastRow();
    if (!column || lastRow < 2) return;
    sheet.getRange(2, column, lastRow - 1, 1).getValues().forEach(function (row) {
      if (row[0]) seen[String(row[0])] = true;
    });
  });
  return seen;
}

function columnNumber_(sheet, header) {
  if (sheet.getLastColumn() === 0) return 0;
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].indexOf(header) + 1;
}

/**
 * Make a tab match the columns it should have without disturbing what is in it.
 * Existing columns keep their position and their data; anything missing is
 * appended on the right, so this is safe to re-run after an upgrade.
 */
function ensureTab_(book, name, columns) {
  let sheet = book.getSheetByName(name);
  if (!sheet) sheet = book.insertSheet(name);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(columns);
  } else {
    const existing = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0];
    const missing = columns.filter(function (c) { return existing.indexOf(c) === -1; });
    if (missing.length) sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, Math.max(columns.length, sheet.getLastColumn())).setFontWeight('bold');
  return sheet;
}

function orderLog_(book) {
  return ensureTab_(book, ERP_TAB_ORDERS, ERP_BASE_COLUMNS.concat(['Status'], ERP_SYNC_COLUMNS));
}
function inquiryLog_(book) {
  return ensureTab_(book, ERP_TAB_INQUIRIES, ERP_BASE_COLUMNS.concat(ERP_SYNC_COLUMNS));
}
function reviewLog_(book) {
  return ensureTab_(book, ERP_TAB_REVIEW, ERP_BASE_COLUMNS.concat(['Why'], ERP_SYNC_COLUMNS));
}


// ============================================================================
// Plumbing
// ============================================================================

function erpRequest_(method, path, body) {
  const token = ERP_PROPS.getProperty('ERP_INGEST_TOKEN');
  if (!token) return { ok: false, code: 0, body: { error: 'ERP_INGEST_TOKEN is not set in Script Properties' } };

  const response = UrlFetchApp.fetch(ERP_URL.replace(/\/$/, '') + path, {
    method: method.toLowerCase(),
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
    payload: body ? JSON.stringify(body) : undefined,
  });

  const text = response.getContentText();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch (e) { parsed = { error: text.slice(0, 300) }; }
  return { ok: response.getResponseCode() === 200, code: response.getResponseCode(), body: parsed };
}

function driveFolder_() {
  const found = DriveApp.getFoldersByName(ERP_DRIVE_FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(ERP_DRIVE_FOLDER);
}

function gmailLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function sanitiseFileName_(name) {
  return String(name).replace(/[\/\\?%*:|"<>]/g, '-');
}
