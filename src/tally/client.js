/**
 * The only thing in the app that talks to Tally.
 *
 * There is exactly ONE client. In simulated mode it points at the in-process
 * fake Tally; in live mode it points at the office machine. The code path is
 * identical, which is the whole point — nothing here gets rewritten at cutover.
 */
import http from 'node:http';
import { config } from '../config.js';
import * as req from './requests.js';
import {
  decodeTallyBuffer,
  parseCompanies,
  parseLedgers,
  parseStockItems,
  parseBills,
  parseVouchers,
  TallyResponseError,
} from './parse.js';

export class TallyUnreachableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'TallyUnreachableError';
    this.cause = cause;
  }
}

/** POST a raw XML request to Tally and return the decoded XML response. */
export function sendXml(xml, { host = config.tally.host, port = config.tally.port, timeoutMs = config.tally.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(xml, 'utf8');
    const started = Date.now();
    const request = http.request(
      {
        host,
        port,
        method: 'POST',
        path: '/',
        headers: { 'Content-Type': 'text/xml;charset=utf-8', 'Content-Length': payload.length },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            xml: decodeTallyBuffer(Buffer.concat(chunks)),
            status: res.statusCode,
            elapsedMs: Date.now() - started,
          })
        );
      }
    );
    request.on('timeout', () => {
      request.destroy();
      reject(new TallyUnreachableError(`Tally at ${host}:${port} did not respond within ${timeoutMs}ms`));
    });
    request.on('error', (err) => {
      const hint =
        err.code === 'ECONNREFUSED'
          ? `Nothing is listening on ${host}:${port}. Is TallyPrime running with Exchange > Data Synchronization enabled on that port?`
          : err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH'
          ? `Cannot reach ${host} on the network.`
          : err.message;
      reject(new TallyUnreachableError(hint, err));
    });
    request.end(payload);
  });
}

async function call(xml, parse) {
  const res = await sendXml(xml);
  return { records: parse(res.xml), raw: res.xml, elapsedMs: res.elapsedMs };
}

export const tally = {
  target() {
    return {
      mode: config.tally.mode,
      host: config.tally.host,
      port: config.tally.port,
      company: config.tally.company,
      url: `http://${config.tally.host}:${config.tally.port}`,
    };
  },

  /** Phase 0. Answers exactly one question: does Tally respond? */
  async ping() {
    const started = Date.now();
    try {
      const res = await sendXml(req.listCompanies());
      const companies = parseCompanies(res.xml);
      const match = companies.find((c) => c.name === config.tally.company);
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        companies,
        companyFound: Boolean(match),
        company: match || null,
        message: match
          ? `Connected. '${config.tally.company}' is loaded.`
          : companies.length
          ? `Connected, but '${config.tally.company}' is not among the loaded companies (${companies.map((c) => c.name).join(', ')}).`
          : 'Connected, but Tally reports no open company.',
      };
    } catch (err) {
      return {
        ok: false,
        elapsedMs: Date.now() - started,
        companies: [],
        companyFound: false,
        error: err.name,
        message: err.message,
      };
    }
  },

  ledgers: () => call(req.listLedgers(config.tally.company), parseLedgers),
  stockItems: () => call(req.listStockItems(config.tally.company), parseStockItems),
  billsReceivable: () => call(req.listBillsReceivable(config.tally.company), parseBills),
  dayBook: (from, to) => call(req.dayBook(config.tally.company, from, to), parseVouchers),

  /** Raw escape hatch used by the Tally Connection console. */
  raw: (xml) => sendXml(xml),

  requests: req,
};

export { TallyResponseError };
