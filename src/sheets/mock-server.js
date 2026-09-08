/**
 * A fake Google, running the REAL Apps Script.
 *
 * This is the same trick as `tally/mock-server.js`, and for the same reason. It
 * is not a second implementation of the sheet protocol written to match the
 * first — that arrangement agrees right up until one side is edited, and then
 * the tests pass while the office breaks. This loads `scripts/erp-sheet-api.gs`
 * verbatim, gives it shims for the four Google services it uses, and serves its
 * own `doPost` over HTTP.
 *
 * So `npm run sheets:verify` exercises the actual script you paste into Google,
 * down to its row-deletion order and its refusal to touch the mail log. What is
 * simulated is Google, not the code.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { config } from '../config.js';

/** A tab: a dense grid of cells, and nothing else. Formats are accepted and ignored. */
class FakeSheet {
  constructor(name) {
    this.name = name;
    this.cells = [];
    this.frozen = 0;
  }
  getName() { return this.name; }

  /** The bottom-most row holding anything. Blank rows below it do not exist. */
  getLastRow() {
    for (let r = this.cells.length - 1; r >= 0; r--) {
      if ((this.cells[r] || []).some(notEmpty)) return r + 1;
    }
    return 0;
  }
  getLastColumn() {
    let last = 0;
    for (const row of this.cells) {
      for (let c = (row || []).length - 1; c >= 0; c--) {
        if (notEmpty(row[c])) { last = Math.max(last, c + 1); break; }
      }
    }
    return last;
  }
  getMaxRows() { return Math.max(1000, this.cells.length); }
  setFrozenRows(n) { this.frozen = n; return this; }

  getRange(row, column, numRows = 1, numColumns = 1) {
    const sheet = this;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const line = sheet.cells[row - 1 + r] || [];
          const cells = [];
          for (let c = 0; c < numColumns; c++) cells.push(line[column - 1 + c] ?? '');
          out.push(cells);
        }
        return out;
      },
      setValues(values) {
        values.forEach((line, r) => {
          const at = row - 1 + r;
          if (!sheet.cells[at]) sheet.cells[at] = [];
          line.forEach((v, c) => { sheet.cells[at][column - 1 + c] = v; });
        });
        return this;
      },
      setValue(v) { return this.setValues([[v]]); },
      clearContent() {
        for (let r = 0; r < numRows; r++) {
          const at = row - 1 + r;
          if (!sheet.cells[at]) continue;
          for (let c = 0; c < numColumns; c++) sheet.cells[at][column - 1 + c] = '';
        }
        return this;
      },
      setNumberFormat() { return this; },
      setFontWeight() { return this; },
    };
  }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  deleteRow(n) { this.cells.splice(n - 1, 1); }
  deleteRows(start, count) { this.cells.splice(start - 1, count); }
}

const notEmpty = (v) => v !== '' && v !== null && v !== undefined;

class FakeBook {
  constructor(name, id) {
    this.name = name;
    this.id = id;
    this.sheets = [];
  }
  getName() { return this.name; }
  getId() { return this.id; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
  getSpreadsheetTimeZone() { return 'Asia/Kolkata'; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  insertSheet(name) {
    const s = new FakeSheet(name);
    this.sheets.push(s);
    return s;
  }
}

/**
 * Load the script with Google's services stubbed out.
 *
 * `vm` rather than `import` because a .gs file is not a module: it is a set of
 * top-level declarations sharing one global scope, which is exactly what a vm
 * context is. Running it any other way would mean editing the file to suit the
 * test, and then the file under test is no longer the file being deployed.
 */
export function loadScript({ book, token }) {
  const source = fs.readFileSync(path.join(config.root, 'scripts', 'erp-sheet-api.gs'), 'utf8');
  const properties = new Map([['ERP_SHEET_TOKEN', token]]);

  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => book,
      openById: () => book,
      flush: () => {},
      MimeType: { JSON: 'application/json' },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => properties.get(k) ?? null,
        setProperty: (k, v) => { properties.set(k, v); },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; }, getContent() { return text; } }),
    },
    // One process, one caller: there is nothing to contend with here. The lock
    // is real in Apps Script and that is where it matters.
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Logger: { log: (m) => console.log('[gs]', m) },
    console,
  };
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'erp-sheet-api.gs' }).runInContext(sandbox);
  return sandbox;
}

/** Serve the script's doPost, so the ERP's own client can be pointed at it. */
export async function startMockSheet({ port = 9200, token = 'mock-token', name = 'Balaji ERP (mock)', id = 'mock-sheet-id' } = {}) {
  const book = new FakeBook(name, id);
  const sandbox = loadScript({ book, token });

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      const out = sandbox.doGet();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(out.getContent());
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const out = sandbox.doPost({ postData: { contents: Buffer.concat(chunks).toString('utf8') } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out.getContent());
    });
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return {
    url: `http://127.0.0.1:${port}/`,
    token,
    book,
    tab: (n) => book.getSheetByName(n),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
