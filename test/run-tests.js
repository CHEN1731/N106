/**
 * Node harness that loads the .gs logic files and validates parsing +
 * comparison against the sample exports. Run: `node test/run-tests.js`.
 *
 * The .gs files guard their module.exports so Apps Script ignores it; here we
 * require them directly as CommonJS modules.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { parseWhatsApp } = require(path.join(root, 'gas', 'Parser.gs'));
const { compareRecords } = require(path.join(root, 'gas', 'Compare.gs'));

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok  - ' + msg); }
  else { console.log('  FAIL- ' + msg); failures++; }
}

const rtoText = fs.readFileSync(path.join(root, 'samples', 'rto.sample.txt'), 'utf8');
const samText = fs.readFileSync(path.join(root, 'samples', 'samsung.sample.txt'), 'utf8');

const rto = parseWhatsApp(rtoText, 'RTO');
const sam = parseWhatsApp(samText, 'Samsung');

console.log('\nParsing:');
assert(rto.length === 5, 'RTO parses 5 site records (got ' + rto.length + ')');
assert(sam.length === 4, 'Samsung parses 4 site records (got ' + sam.length + ')');

const rtoA = rto.find(r => r.date === '2026-08-15' && /Zone A/i.test(r.area));
assert(rtoA && rtoA.activity === 'Rebar fixing for slab', 'RTO 15/08 Zone A activity extracted');
assert(rtoA && rtoA.remark === '80% complete, rest tomorrow', 'RTO 15/08 Zone A remark extracted');
assert(rtoA && rtoA.photos >= 1, 'RTO 15/08 Zone A folds in the standalone photo (got ' + (rtoA && rtoA.photos) + ')');

const rtoDate = rto.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
assert(rtoDate, 'all RTO dates normalised to ISO yyyy-mm-dd');

console.log('\nComparison:');
const cmp = compareRecords(rto, sam);
const byKey = {};
cmp.rows.forEach(r => { byKey[r.date + '|' + r.area] = r; });

assert(byKey['2026-08-15|Zone A - Level 1'].status === 'Match', '15/08 Zone A -> Match');
assert(byKey['2026-08-15|Zone B - Basement'].status === 'Conflict', '15/08 Zone B (25 vs 30 m3) -> Conflict');
assert(byKey['2026-08-15|Zone C - Roof'].status === 'MissingSamsung', '15/08 Zone C -> MissingSamsung');
assert(byKey['2026-08-16|Zone A - Level 1'].status === 'Match', '16/08 Zone A -> Match');
assert(byKey['2026-08-16|Zone B - Basement'].status === 'MissingSamsung', '16/08 Zone B -> MissingSamsung');
assert(byKey['2026-08-16|Zone D - External'].status === 'MissingRTO', '16/08 Zone D -> MissingRTO');

console.log('\nSummary:');
const d15 = cmp.daily.find(d => d.date === '2026-08-15');
assert(d15 && d15.total === 3, '15/08 has 3 distinct keys');
assert(d15 && d15.matched === 1, '15/08 matched = 1');
assert(cmp.overall.total === 6, 'overall 6 distinct keys');
assert(cmp.overall.matched === 2, 'overall matched = 2');
assert(cmp.overall.accuracyPct === 33.3, 'overall accuracy 33.3% (got ' + cmp.overall.accuracyPct + ')');

console.log('\nExample rows:');
cmp.rows.forEach(r => {
  console.log('  ' + r.date + '  ' + r.area.padEnd(18) + '  ' + r.status + '  sim=' + r.similarity);
});

console.log('\n' + (failures ? (failures + ' FAILED') : 'ALL PASSED'));
process.exit(failures ? 1 : 0);
