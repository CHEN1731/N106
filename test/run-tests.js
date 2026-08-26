/**
 * Node harness that loads the .gs logic files and validates parsing +
 * comparison against the sample exports. Run: `node test/run-tests.js`.
 *
 * The .gs files guard their module.exports so Apps Script ignores it; here we
 * require them directly as CommonJS modules. Samples are free-form messages
 * (no labelled template) to exercise area canonicalisation and the General
 * bucket.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { parseWhatsApp, canonicalArea_ } = require(path.join(root, 'gas', 'Parser.gs'));
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

console.log('\nArea canonicalisation:');
assert(canonicalArea_('Concrete pour at basement, 25 m3') === 'Zone B', '"basement" -> Zone B');
assert(canonicalArea_('zone-a rebar fixing') === 'Zone A', '"zone-a" -> Zone A');
assert(canonicalArea_('Roof waterproofing membrane') === 'Zone C', '"roof" -> Zone C');
assert(canonicalArea_('external zone clearance') === 'Zone D', '"external" -> Zone D');
assert(canonicalArea_('delivered 10 pallets') === '', 'no area term -> "" (General later)');

console.log('\nParsing (free-form):');
assert(rto.length === 5, 'RTO parses 5 records, greetings/acks skipped (got ' + rto.length + ')');
assert(sam.length === 4, 'Samsung parses 4 records (got ' + sam.length + ')');

const rtoA = rto.find(r => r.date === '2026-08-15' && r.area === 'Zone A');
assert(!!rtoA, 'RTO 15/08 free text canonicalised to Zone A');
assert(rtoA && rtoA.photos >= 1, 'RTO 15/08 Zone A folds in the standalone photo (got ' + (rtoA && rtoA.photos) + ')');

const general = rto.find(r => r.area === 'General');
assert(!!general, 'RTO "Delivered 10 pallets…" (no area, has signal) -> General bucket');
assert(rto.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date)), 'all RTO dates normalised to ISO');

console.log('\nComparison (matched across differing wordings):');
const cmp = compareRecords(rto, sam);
const byKey = {};
cmp.rows.forEach(r => { byKey[r.date + '|' + r.area] = r; });

assert(byKey['2026-08-15|Zone A'].status === 'Match', '15/08 Zone A: "80% done" vs "80% complete" -> Match');
assert(byKey['2026-08-15|Zone B'].status === 'Conflict', '15/08 Zone B: 25 m3 vs 30 m3 -> Conflict');
assert(byKey['2026-08-15|Zone C'].status === 'MissingSamsung', '15/08 Zone C -> MissingSamsung');
assert(byKey['2026-08-16|Zone A'].status === 'Match', '16/08 Zone A -> Match');
assert(byKey['2026-08-16|General'].status === 'MissingSamsung', '16/08 General -> MissingSamsung');
assert(byKey['2026-08-16|Zone D'].status === 'MissingRTO', '16/08 Zone D (external) -> MissingRTO');

console.log('\nSummary:');
assert(cmp.overall.total === 6, 'overall 6 distinct keys');
assert(cmp.overall.matched === 2, 'overall matched = 2');
assert(cmp.overall.conflicts === 1, 'overall conflicts = 1');
assert(cmp.overall.accuracyPct === 33.3, 'overall accuracy 33.3% (got ' + cmp.overall.accuracyPct + ')');

console.log('\nExample rows:');
cmp.rows.forEach(r => {
  console.log('  ' + r.date + '  ' + r.area.padEnd(10) + '  ' + r.status.padEnd(15) + '  sim=' + r.similarity);
});

console.log('\n' + (failures ? (failures + ' FAILED') : 'ALL PASSED'));
process.exit(failures ? 1 : 0);
