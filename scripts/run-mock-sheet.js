/**
 * The simulated sheet, on its own.
 *
 *   npm run sheets:mock
 *
 * Runs `scripts/erp-sheet-api.gs` — the actual file you paste into Google —
 * behind a local HTTP server, so the ERP can be pointed at it exactly as it
 * would be pointed at a real deployment. Same client, same protocol, socket
 * swapped, which is the arrangement the simulated Tally already uses.
 *
 * Nothing persists: the tabs live in memory and go when the process does. It is
 * for seeing the screens work and for `npm run sheets:verify`, not for storage.
 */
import { startMockSheet } from '../src/sheets/mock-server.js';

const port = Number(process.env.MOCK_SHEET_PORT || 9200);
const token = process.env.MOCK_SHEET_TOKEN || 'mock-sheet-token';
const sheet = await startMockSheet({ port, token });

console.log('');
console.log('  Simulated Google Sheet');
console.log(`  URL     ${sheet.url}`);
console.log(`  Token   ${token}`);
console.log('');
console.log('  Point the ERP at it:');
console.log(`    SHEETS_WEBAPP_URL=${sheet.url} SHEETS_TOKEN=${token} npm start`);
console.log('');

process.on('SIGINT', async () => { await sheet.stop(); process.exit(0); });
