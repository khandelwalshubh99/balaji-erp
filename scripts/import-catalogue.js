/**
 * Import a price-list workbook into the catalogue.
 *
 *   npm run catalogue:import -- "/path/to/balaji-price-list-2026-09-01.xlsx"
 *   npm run catalogue:import -- <file> --replace      # drop what's there first
 *   npm run catalogue:import -- <file> --sheet "Price List"
 */
import { importCatalogue, writeTallySeed } from '../src/catalogue/import.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run catalogue:import -- <price-list.xlsx> [--replace] [--sheet "Name"]');
  process.exit(1);
}
const sheetFlag = args.indexOf('--sheet');

const r = importCatalogue(file, {
  replace: args.includes('--replace'),
  sheet: sheetFlag > -1 ? args[sheetFlag + 1] : undefined,
});

console.log(`\n  ${r.file}  ·  sheet "${r.sheet}"  (available: ${r.sheetNames.join(', ')})`);
console.log(`  header mapping:`);
for (const [field, header] of Object.entries(r.mapping)) {
  console.log(`    ${field.padEnd(12)} <- ${header || '(none)'}`);
}
console.log('');
console.log(`  rows read          ${r.rowsRead}`);
console.log(`  imported           ${r.imported}   (${r.added} new, ${r.updated} updated)`);
if (r.duplicateCodes) console.log(`  duplicate codes    ${r.duplicateCodes}  (last one kept)`);
if (r.skippedRows) console.log(`  skipped rows       ${r.skippedRows}  (no part number and no description)`);
console.log(`  brands             ${r.brands.join(', ')}`);
console.log('');
console.log(`  needs attention:`);
console.log(`    without HSN      ${r.missingHsn}`);
console.log(`    priced at zero   ${r.zeroPrice}`);

const seed = writeTallySeed();
console.log('');
if (seed.written) {
  console.log(`  simulated Tally will stock ${seed.stocked} of ${seed.catalogue} catalogue items.`);
  console.log(`  Restart the server, then run a sync to pull them in.`);
} else {
  console.log(`  tally seed not written: ${seed.reason}`);
}
console.log('');
