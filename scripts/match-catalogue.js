/** Match the catalogue against whatever Tally last gave us. */
import { matchCatalogue, matchSummary, unmatchedItems, orphanStockItems } from '../src/catalogue/match.js';

const r = matchCatalogue();
const pct = (n) => `${((n / r.catalogueItems) * 100).toFixed(1)}%`;

console.log(`\n  ${r.catalogueItems} catalogue items vs ${r.stockItems} Tally stock items\n`);
console.log(`  exact (part number)   ${String(r.exact).padStart(6)}  ${pct(r.exact)}`);
console.log(`  code inside name      ${String(r['code-in-name']).padStart(6)}  ${pct(r['code-in-name'])}`);
console.log(`  description match     ${String(r.name).padStart(6)}  ${pct(r.name)}`);
if (r.manual) console.log(`  manual (kept)         ${String(r.manual).padStart(6)}  ${pct(r.manual)}`);
console.log(`  unmatched             ${String(r.unmatched).padStart(6)}  ${pct(r.unmatched)}`);
if (r.ambiguous) console.log(`\n  ${r.ambiguous} code(s) appeared in more than one Tally item and were left unmatched.`);

const s = matchSummary();
console.log(`\n  Quotable but not stocked in Tally: ${s.unmatched}`);
console.log(`  Stocked in Tally but not in the catalogue: ${s.orphanStock}`);

console.log('\n  Sample unmatched catalogue items:');
for (const i of unmatchedItems(5)) console.log(`    ${i.code.padEnd(16)} ${i.brand.padEnd(10)} ${i.name.slice(0, 50)}`);

const orphans = orphanStockItems(5);
if (orphans.length) {
  console.log('\n  Sample stock with no catalogue entry (highest value first):');
  for (const o of orphans) console.log(`    ${(o.part_number || '-').padEnd(16)} ${o.name.slice(0, 50)}`);
}
console.log('');
