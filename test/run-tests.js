/**
 * Node harness that loads the .gs logic files and validates parsing +
 * comparison against the sample exports (real N106 WhatsApp format).
 * Run: `node test/run-tests.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { parseWhatsApp, resolveLocator_, normalizeDate_ } = require(path.join(root, 'gas', 'Parser.gs'));
const { compareRecords } = require(path.join(root, 'gas', 'Compare.gs'));

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok  - ' + msg); }
  else { console.log('  FAIL- ' + msg); failures++; }
}

console.log('\nLocator + date:');
assert(normalizeDate_('5/8/26') === '2026-08-05', '"5/8/26" -> 2026-08-05');
const loc1 = resolveLocator_('Sec-C/ER15(Mb)\nDwall works');
assert(loc1.section === 'Sec-C' && loc1.segment === 'Mb' && loc1.area === 'Sec-C/Mb',
  '"Sec-C/ER15(Mb)" -> Sec-C + Mb');
const loc2 = resolveLocator_('Sec-D/CCL/Ub/Base Slab/Kian Hup:');
assert(loc2.area === 'Sec-D/Ub', '"Sec-D/CCL/Ub/Base Slab" -> Sec-D/Ub');

console.log('\nInvisible-mark stripping:');
const marked = '‎[5/8/26, 09:00:00] ~ Eng: Sec-C(Mb)\nDwall works\n‎image omitted';
const mk = parseWhatsApp(marked, 'RTO');
assert(mk.length === 1 && mk[0].area === 'Sec-C/Mb', 'header/media with LRM marks still parse');
assert(mk[0].photos === 1, 'trailing "image omitted" counted as a photo');

const rto = parseWhatsApp(fs.readFileSync(path.join(root, 'samples', 'rto.sample.txt'), 'utf8'), 'RTO');
const sam = parseWhatsApp(fs.readFileSync(path.join(root, 'samples', 'samsung.sample.txt'), 'utf8'), 'Samsung');

console.log('\nParsing:');
assert(rto.length === 3, 'RTO parses 3 records (Mb, Ub, Ld) — got ' + rto.length);
assert(sam.length === 3, 'Samsung parses 3 records (Mb, Ub, Ua), greeting skipped — got ' + sam.length);

const mb = rto.find(r => r.area === 'Sec-C/Mb');
assert(!!mb, 'RTO Mb record built');
assert(mb && mb.photos === 3, 'RTO Mb folds inline + 2 standalone photos = 3 (got ' + (mb && mb.photos) + ')');
const ub = rto.find(r => r.area === 'Sec-D/Ub');
assert(ub && /manpower/i.test(ub.remark), 'RTO Ub manpower line captured in remark');
assert(rto.every(r => r.date === '2026-08-05'), 'all RTO dates -> 2026-08-05');

console.log('\nComparison:');
const cmp = compareRecords(rto, sam);
const byKey = {};
cmp.rows.forEach(r => { byKey[r.area] = r; });
assert(byKey['Sec-C/Mb'].status === 'Match', 'Sec-C/Mb (differently worded) -> Match');
assert(byKey['Sec-D/Ub'].status === 'Conflict', 'Sec-D/Ub (7pax vs 9pax) -> Conflict');
assert(byKey['Sec-C/Ld'].status === 'MissingSamsung', 'Sec-C/Ld -> MissingSamsung');
assert(byKey['Sec-D/Ua'].status === 'MissingRTO', 'Sec-D/Ua -> MissingRTO');

console.log('\nQuantity-aware conflict (identifiers ignored):');
assert(byKey['Sec-C/Mb'].status !== 'Conflict',
  'DW64/ER15/chainage differences do NOT force a conflict (only units do)');

console.log('\nSummary:');
assert(cmp.overall.total === 4, 'overall 4 distinct keys');
assert(cmp.overall.matched === 1, 'overall matched = 1');
assert(cmp.overall.conflicts === 1, 'overall conflicts = 1');
assert(cmp.overall.accuracyPct === 25, 'overall accuracy 25% (got ' + cmp.overall.accuracyPct + ')');

console.log('\nExample rows:');
cmp.rows.forEach(r => {
  console.log('  ' + r.date + '  ' + r.area.padEnd(10) + '  ' + r.status.padEnd(15) + '  sim=' + r.similarity);
});

console.log('\n' + (failures ? (failures + ' FAILED') : 'ALL PASSED'));
process.exit(failures ? 1 : 0);
