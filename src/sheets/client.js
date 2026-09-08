/**
 * The only thing in the app that talks to the Google Sheet.
 *
 * It talks to an Apps Script Web App bound to that sheet, not to the Sheets
 * API, and that is a deliberate choice with two consequences worth stating.
 *
 * FIRST, THE ERP HOLDS NO GOOGLE CREDENTIALS. A shared token, exactly like the
 * ingest endpoint, and Google's own authorisation lives inside the script where
 * the owner granted it. There is no service-account key on disk to leak, and
 * losing this token costs you one sheet rather than an account.
 *
 * SECOND, AND THIS IS THE ONE THAT MATTERS: EVERY CALL IS OUTBOUND.
 * The mail sweep works the other way — Apps Script pushes into the ERP — which
 * is why it needs a public https name and a tunnel, "the one genuinely fiddly
 * part" in the mail documentation. Nothing here needs that. A laptop on office
 * wifi can reach script.google.com, so the store works from localhost with no
 * port forward, no static IP and no tunnel at all.
 */
import { config } from '../config.js';

export class SheetUnreachableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SheetUnreachableError';
    this.cause = cause;
  }
}

/** The script answered, and said no. A different thing from not answering. */
export class SheetRefusedError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SheetRefusedError';
    this.code = code || null;
  }
}

/**
 * One call to the web app.
 *
 * Everything is a POST carrying `{token, op, ...}`. Apps Script web apps answer
 * a POST with a 302 to script.googleusercontent.com and the body arrives from
 * there, which `fetch` follows on its own — but it means a wrong URL or a
 * deployment that was never authorised comes back as an HTML sign-in page with
 * status 200 rather than as an error. Hence the content check below: HTML where
 * JSON was expected is the single most common symptom of a misdeployed script,
 * and saying so is worth more than a JSON parse error nobody can act on.
 */
export async function call(op, payload = {}, { url, token, timeoutMs } = {}) {
  const target = url || settingsUrl();
  const secret = token !== undefined ? token : settingsToken();
  if (!target) throw new SheetRefusedError('No Google Sheet is connected.', 'not-configured');

  const controller = new AbortController();
  const ms = timeoutMs || config.sheets.timeoutMs;
  const timer = setTimeout(() => controller.abort(), ms);
  const started = Date.now();
  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: secret, op, ...payload }),
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new SheetUnreachableError(
        `The sheet did not answer within ${Math.round(ms / 1000)}s. Apps Script caps a single run at about six minutes; a very large push can genuinely take that long.`
      );
    }
    throw new SheetUnreachableError(`Could not reach the sheet: ${err.message}`, err);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (/^\s*</.test(text)) {
    throw new SheetRefusedError(
      'Google returned a web page instead of an answer. The usual causes, in order: the deployment is not set to "Anyone" access, the URL is the /dev one rather than /exec, or the script was edited and never re-deployed.',
      'not-json'
    );
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SheetRefusedError(`The sheet answered with something that is not JSON: ${text.slice(0, 200)}`, 'not-json');
  }

  if (!res.ok) throw new SheetRefusedError(body.error || `HTTP ${res.status} from the sheet`, body.code);
  if (body.ok === false) throw new SheetRefusedError(body.error || 'The sheet refused the request.', body.code);
  return { ...body, elapsedMs: Date.now() - started };
}

// The settings lookups are indirected through here so this module can be used
// with an explicit url/token — which is what the "Test connection" button does,
// checking values a person has typed but not yet saved.
let readSettings = () => ({ url: config.sheets.webAppUrl, token: config.sheets.token });
export function useSettings(fn) {
  readSettings = fn;
}
const settingsUrl = () => readSettings().url;
const settingsToken = () => readSettings().token;

/**
 * A web app URL, checked for the mistake everybody makes.
 *
 * `/dev` is the head deployment: it works in a browser where you are signed in
 * and returns a sign-in page to everything else, so it looks correct right up
 * until the ERP uses it. Refusing it here turns a confusing intermittent
 * failure into a sentence at the moment of pasting.
 */
export function parseWebAppUrl(input) {
  const s = String(input || '').trim();
  if (!s) return { url: null, error: null };
  // The simulated sheet, exactly as TALLY_MODE=simulated points the one Tally
  // client at a fake Tally on this machine. Same client, same protocol, socket
  // swapped — `npm run sheets:verify` is what uses it.
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(s)) return { url: s, error: null };
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/(exec|dev)\b/.test(s)) {
    return {
      url: null,
      error: 'That is not an Apps Script web app URL. In the script editor: Deploy → New deployment → Web app, then copy the URL ending in /exec.',
    };
  }
  if (s.includes('/dev')) {
    return {
      url: null,
      error: 'That is the /dev URL, which only works in a browser you are signed into. Use the /exec URL from the deployment.',
    };
  }
  return { url: s.split('?')[0], error: null };
}
