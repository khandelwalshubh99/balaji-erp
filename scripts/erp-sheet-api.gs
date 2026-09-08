/**
 * BALAJI ENTERPRISES — THE SHEET AS THE ERP'S STORE
 * ============================================================================
 * Paste this into the SAME Apps Script project as erp-mail-sweep.gs, bound to
 * the same spreadsheet, and deploy it as a Web App. From then on the ERP reads
 * and writes this sheet over that one URL.
 *
 * WHY THIS EXISTS RATHER THAN THE SHEETS API
 *   The ERP holds no Google credentials — no service-account key, no OAuth
 *   token. It holds a shared secret, and Google's authorisation lives here,
 *   under the account that owns the sheet.
 *
 *   And it inverts the direction. The mail sweep pushes INTO the ERP, which is
 *   why it needs a public https name and a tunnel. Every call here is the ERP
 *   reaching OUT to script.google.com, so the ERP works on localhost, on office
 *   wifi, behind any router, with nothing forwarded.
 *
 * WHO OWNS WHAT
 *   This script writes ONLY the tabs the ERP owns — Quotations, Orders,
 *   Dispatches and so on. It never touches Order Log, Inquiry Log or Needs
 *   Review: those are the mail sweep's record of what it pushed, and they are
 *   what the ERP can be reconciled against. A script that rewrote them would
 *   destroy the only independent check there is.
 *
 * SETUP
 *   1. Paste this file in alongside erp-mail-sweep.gs.
 *   2. Run SHEETAPI_setup() once. It mints a token and prints it.
 *   3. Deploy → New deployment → Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      "Anyone" sounds worse than it is: without the token every request is
 *      refused, and the token is the same class of secret as INGEST_TOKEN.
 *   4. Copy the /exec URL. Paste it and the token into the ERP's Connection
 *      screen. The /dev URL will not work — it answers a sign-in page to
 *      anything that is not your logged-in browser.
 *   5. Re-deploy after editing this file. Apps Script serves the last DEPLOYED
 *      version, not the last saved one, which is the most common reason a
 *      change appears to have no effect.
 */

// Apps Script shares one global scope across every file in a project, so every
// name here carries a prefix. A collision with a file added months from now
// throws "Identifier already declared" and stops the whole project.
const SHEETAPI_VERSION = '1.0.0';
const SHEETAPI_TOKEN_PROPERTY = 'ERP_SHEET_TOKEN';
const SHEETAPI_ID_PROPERTY = 'ERP_SHEET_ID_OVERRIDE';

/** Tabs this script must never write to, whatever it is asked. */
const SHEETAPI_PROTECTED = ['Order Log', 'Inquiry Log', 'Needs Review'];

// ============================================================================
// Setup
// ============================================================================

/**
 * Run once. Mints the shared token, checks the sheet is reachable, and prints
 * what to paste where.
 */
function SHEETAPI_setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty(SHEETAPI_TOKEN_PROPERTY);
  if (!token) {
    token = SHEETAPI_randomToken_();
    props.setProperty(SHEETAPI_TOKEN_PROPERTY, token);
    Logger.log('Minted a new token.');
  } else {
    Logger.log('A token already exists — reusing it. To roll it, run SHEETAPI_rollToken().');
  }

  const book = SHEETAPI_book_();
  Logger.log('Spreadsheet : ' + book.getName());
  Logger.log('Sheet id    : ' + book.getId());
  Logger.log('Tabs        : ' + book.getSheets().map(function (s) { return s.getName(); }).join(', '));
  Logger.log('');
  Logger.log('TOKEN       : ' + token);
  Logger.log('');
  Logger.log('Now: Deploy → New deployment → Web app, Execute as Me, Who has access Anyone.');
  Logger.log('Then paste the /exec URL and the token above into the ERP Connection screen.');
  return token;
}

/** Replace the token. Every ERP using the old one stops working immediately. */
function SHEETAPI_rollToken() {
  const token = SHEETAPI_randomToken_();
  PropertiesService.getScriptProperties().setProperty(SHEETAPI_TOKEN_PROPERTY, token);
  Logger.log('New token: ' + token);
  Logger.log('Paste it into the ERP Connection screen. The old one is now dead.');
  return token;
}

function SHEETAPI_randomToken_() {
  const bytes = [];
  for (let i = 0; i < 32; i++) bytes.push(Math.floor(Math.random() * 256));
  return bytes.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}

/**
 * The spreadsheet this serves.
 *
 * Bound script first, because that is what it should be. The property and the
 * mail script's constant are fallbacks for a standalone project.
 */
function SHEETAPI_book_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const override = PropertiesService.getScriptProperties().getProperty(SHEETAPI_ID_PROPERTY);
  if (override) return SpreadsheetApp.openById(override);
  if (typeof ERP_SHEET_ID !== 'undefined' && ERP_SHEET_ID.indexOf('PASTE') !== 0) {
    return SpreadsheetApp.openById(ERP_SHEET_ID);
  }
  throw new Error('No spreadsheet. Bind this script to the sheet, or set ' + SHEETAPI_ID_PROPERTY + '.');
}

// ============================================================================
// The endpoint
// ============================================================================

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!SHEETAPI_tokenOk_(body.token)) {
      return SHEETAPI_json_({ ok: false, error: 'Bad token.', code: 'bad-token' });
    }
    return SHEETAPI_json_(SHEETAPI_dispatch_(body));
  } catch (err) {
    return SHEETAPI_json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * A GET is answered, briefly, and without the token.
 *
 * Only so that opening the URL in a browser tells you whether the deployment is
 * live. It reveals the version and nothing else — no data, no tab names.
 */
function doGet() {
  return SHEETAPI_json_({ ok: true, service: 'balaji-erp-sheet-api', version: SHEETAPI_VERSION, note: 'POST with a token.' });
}

function SHEETAPI_tokenOk_(given) {
  const want = PropertiesService.getScriptProperties().getProperty(SHEETAPI_TOKEN_PROPERTY);
  // No token set means the endpoint is off. It fails closed, exactly as the
  // ERP's ingest endpoint does: an open endpoint that can rewrite the order
  // book is worse than no endpoint.
  if (!want) return false;
  const got = String(given || '');
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function SHEETAPI_dispatch_(body) {
  switch (body.op) {
    case 'ping':  return SHEETAPI_ping_();
    case 'read':  return SHEETAPI_read_(body.tabs || []);
    case 'batch': return SHEETAPI_batch_(body.writes || []);
    default: return { ok: false, error: 'Unknown op: ' + body.op, code: 'unknown-op' };
  }
}

function SHEETAPI_json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// ping
// ============================================================================

function SHEETAPI_ping_() {
  const book = SHEETAPI_book_();
  return {
    ok: true,
    version: SHEETAPI_VERSION,
    spreadsheetId: book.getId(),
    spreadsheetName: book.getName(),
    url: book.getUrl(),
    timeZone: book.getSpreadsheetTimeZone(),
    tabs: book.getSheets().map(function (s) {
      return { name: s.getName(), rows: Math.max(0, s.getLastRow() - 1), columns: s.getLastColumn() };
    }),
  };
}

// ============================================================================
// read
// ============================================================================

/**
 * Hand back whole tabs.
 *
 * A tab that does not exist comes back absent rather than as an error. On a
 * sheet the ERP has never pushed to, every tab is absent — which is the normal
 * first run, not a fault.
 */
function SHEETAPI_read_(tabs) {
  const book = SHEETAPI_book_();
  const out = {};
  for (let i = 0; i < tabs.length; i++) {
    const sheet = book.getSheetByName(tabs[i]);
    if (!sheet || sheet.getLastRow() < 1) continue;
    const values = sheet.getDataRange().getValues();
    const header = values.shift().map(function (h) { return String(h).trim(); });
    out[tabs[i]] = {
      header: header,
      // Trailing blank rows are what you get after someone deletes content
      // without deleting rows. They are not records.
      rows: values.filter(SHEETAPI_notBlank_).map(SHEETAPI_serialiseRow_),
    };
  }
  return { ok: true, sheets: out };
}

function SHEETAPI_notBlank_(row) {
  for (let i = 0; i < row.length; i++) {
    if (row[i] !== '' && row[i] !== null) return true;
  }
  return false;
}

/** Dates become ISO text. Everything downstream stores dates as text. */
function SHEETAPI_serialiseRow_(row) {
  return row.map(function (v) {
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}

// ============================================================================
// write
// ============================================================================

function SHEETAPI_batch_(writes) {
  // One writer at a time. Two ERP instances draining their outboxes at the same
  // moment would otherwise interleave a read of the key column with the other's
  // append, and the loser writes a duplicate row.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'Another write is in progress.', code: 'locked' };
  try {
    const book = SHEETAPI_book_();
    const written = {};
    for (let i = 0; i < writes.length; i++) {
      const w = writes[i];
      if (SHEETAPI_PROTECTED.indexOf(w.tab) !== -1) {
        return { ok: false, error: 'Refusing to write ' + w.tab + ': that tab belongs to the mail sweep.', code: 'protected-tab' };
      }
      written[w.tab] = SHEETAPI_write_(book, w);
    }
    SpreadsheetApp.flush();
    return { ok: true, written: written };
  } finally {
    lock.releaseLock();
  }
}

function SHEETAPI_write_(book, w) {
  const sheet = SHEETAPI_ensureTab_(book, w.tab, w.header, w.types);
  const columns = SHEETAPI_columnMap_(sheet, w.header);
  const mode = w.mode || 'upsert';
  const rows = w.rows || [];

  if (mode === 'replace') {
    SHEETAPI_clearBody_(sheet);
    SHEETAPI_appendBulk_(sheet, w.header, rows);
    return rows.length;
  }

  if (mode === 'append') {
    SHEETAPI_appendBulk_(sheet, w.header, rows);
    return rows.length;
  }

  if (mode === 'replace-children') {
    // The parents named here are being rewritten wholesale, so their existing
    // lines go first. A line deleted in the ERP has to disappear from the
    // sheet, and an upsert can only ever add and amend.
    const parentColumn = columns[w.parentColumn];
    const wanted = {};
    (w.parentValues || []).forEach(function (v) { wanted[String(v)] = true; });
    SHEETAPI_deleteWhere_(sheet, parentColumn, wanted);
    SHEETAPI_appendBulk_(sheet, w.header, rows);
    return rows.length;
  }

  // upsert / append-missing
  const keyColumn = columns[w.key];
  const existing = SHEETAPI_keyRows_(sheet, keyColumn);

  if (w.remove && w.remove.length) {
    const gone = {};
    w.remove.forEach(function (v) { gone[String(v)] = true; });
    SHEETAPI_deleteWhere_(sheet, keyColumn, gone);
  }

  const keyAt = w.header.indexOf(w.key);
  const fresh = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const at = existing[String(row[keyAt])];
    if (at === undefined) { fresh.push(row); continue; }
    if (mode === 'append-missing') continue;      // already there; leave it alone
    SHEETAPI_updateRow_(sheet, at, w.header, columns, row);
  }
  SHEETAPI_appendBulk_(sheet, w.header, fresh);
  return rows.length;
}

/**
 * The tab, with our columns present.
 *
 * A column we need but cannot find is appended rather than inserted, and a
 * column we do not recognise is left alone. Someone adding a "Chased on"
 * column of their own is a good thing — a sheet people annotate is a sheet
 * people read — and the ERP has no business deleting it.
 */
function SHEETAPI_ensureTab_(book, name, header, types) {
  let sheet = book.getSheetByName(name);
  const fresh = !sheet;
  if (fresh) sheet = book.insertSheet(name);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  } else {
    const have = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(String);
    const missing = header.filter(function (h) { return have.indexOf(h) === -1; });
    if (missing.length) {
      sheet.getRange(1, have.length + 1, 1, missing.length).setValues([missing]);
    }
  }

  if (fresh) {
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
    // Formats are set once, on creation. Text for everything that is not a
    // number, which is what keeps BE/SO/2627/0031 from being read as a date
    // and a ten-digit PO number from arriving as 4.5E+09.
    for (let i = 0; i < header.length; i++) {
      const t = (types && types[i]) || 'text';
      const format = t === 'real' ? '0.00' : t === 'int' ? '0' : '@';
      sheet.getRange(2, i + 1, sheet.getMaxRows() - 1, 1).setNumberFormat(format);
    }
  }
  return sheet;
}

/** Our header names to 1-based column numbers, by name and never by position. */
function SHEETAPI_columnMap_(sheet, header) {
  const have = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(function (h) { return String(h).trim(); });
  const map = {};
  for (let i = 0; i < header.length; i++) {
    const at = have.indexOf(header[i]);
    if (at === -1) throw new Error('Column "' + header[i] + '" is missing from ' + sheet.getName() + ' and could not be added.');
    map[header[i]] = at + 1;
  }
  return map;
}

/**
 * Empty a tab, keeping its header.
 *
 * Rows are DELETED rather than cleared. Clearing leaves getLastRow() reporting
 * the old bottom of the sheet until a flush catches up, and an append that
 * trusts it writes the replacement rows below a block of blanks — a tab that
 * looks corrupt and reads as empty. Deleting the rows is unambiguous.
 */
function SHEETAPI_clearBody_(sheet) {
  const last = sheet.getLastRow();
  if (last > 1) sheet.deleteRows(2, last - 1);
}

/** Key value to row number, for every row currently in the tab. */
function SHEETAPI_keyRows_(sheet, column) {
  const out = {};
  const last = sheet.getLastRow();
  if (last < 2) return out;
  const values = sheet.getRange(2, column, last - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    const v = values[i][0];
    if (v !== '' && v !== null) out[String(v)] = i + 2;
  }
  return out;
}

/** Delete every row whose value in `column` is a key of `wanted`. */
function SHEETAPI_deleteWhere_(sheet, column, wanted) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const values = sheet.getRange(2, column, last - 1, 1).getValues();
  const doomed = [];
  for (let i = 0; i < values.length; i++) {
    if (wanted[String(values[i][0])]) doomed.push(i + 2);
  }
  // Bottom up, so deleting one row never moves the next one out from under us.
  for (let i = doomed.length - 1; i >= 0; i--) sheet.deleteRow(doomed[i]);
}

function SHEETAPI_updateRow_(sheet, rowNumber, header, columns, row) {
  // Written column by column so that anything a person added to the right of
  // our columns survives an update untouched.
  for (let i = 0; i < header.length; i++) {
    sheet.getRange(rowNumber, columns[header[i]]).setValue(row[i]);
  }
}

/**
 * Append in one call.
 *
 * The fast path needs our columns to be the leftmost ones in order, which they
 * are unless someone has rearranged the tab. When they are not, it falls back
 * to placing each row cell by cell, which is slower and still correct.
 */
function SHEETAPI_appendBulk_(sheet, header, rows) {
  if (!rows.length) return;
  const have = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].map(function (h) { return String(h).trim(); });
  let contiguous = true;
  for (let i = 0; i < header.length; i++) {
    if (have[i] !== header[i]) { contiguous = false; break; }
  }
  const start = sheet.getLastRow() + 1;
  if (contiguous) {
    sheet.getRange(start, 1, rows.length, header.length).setValues(rows);
    return;
  }
  const columns = SHEETAPI_columnMap_(sheet, header);
  for (let r = 0; r < rows.length; r++) {
    SHEETAPI_updateRow_(sheet, start + r, header, columns, rows[r]);
  }
}
