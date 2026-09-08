/**
 * Settings a person can change from a screen.
 *
 * Deliberately separate from `config`, which reads .env and belongs to whoever
 * runs the server. Anything here is safe for someone to correct on a Tuesday
 * afternoon without a restart and without a deploy.
 */
import { db } from '../db/index.js';

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value, actor = null) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
      updated_at = datetime('now'), updated_by = excluded.updated_by`)
    .run(key, value === null || value === undefined ? null : String(value), actor?.id || null);
  return getSetting(key);
}

/**
 * A Google Sheets link, reduced to the sheet id and rebuilt.
 *
 * People paste the whole URL out of the address bar, complete with `/edit`, a
 * `#gid=` and a sharing query string. Keeping only the id is what makes the
 * stored value comparable to the ERP_SHEET_ID sitting in the Apps Script, which
 * is the entire reason for storing it.
 */
export function parseSheetId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const inUrl = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/.exec(s);
  if (inUrl) return inUrl[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : null;
}

export const sheetUrlFor = (id) => (id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null);
