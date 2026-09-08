/**
 * The whole thing, running against a simulated sheet.
 *
 *   npm run sheets:demo
 *
 * Starts the simulated sheet, points the ERP at it and boots the app on 4200
 * against a throwaway database. The quickest way to see the Connection screen
 * with a live store behind it without deploying anything to Google.
 */
const port = Number(process.env.MOCK_SHEET_PORT || 9200);
const token = process.env.MOCK_SHEET_TOKEN || 'mock-sheet-token';

// Set before anything imports config.js, which reads the environment once at
// load and never again.
process.env.SHEETS_WEBAPP_URL = `http://127.0.0.1:${port}/`;
process.env.SHEETS_TOKEN = token;
process.env.INGEST_TOKEN = process.env.INGEST_TOKEN || 'demo-token-local-only';

const { startMockSheet } = await import('../src/sheets/mock-server.js');
const sheet = await startMockSheet({ port, token, name: 'Balaji ERP — simulated sheet' });
console.log(`[sheets] simulated sheet on ${sheet.url}`);

await import('../src/server.js');
