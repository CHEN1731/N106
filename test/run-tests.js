/**
 * Node harness for the .gs logic (Productivity & Summary Dashboard).
 * Loads the .gs files into one shared VM sandbox (mirrors Apps Script's global
 * scope). Run: `node test/run-tests.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = {};
vm.createContext(sandbox);
['Parser.gs', 'Compare.gs', 'Extract.gs', 'Docx.gs', 'Code.gs'].forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(root, 'gas', f), 'utf8'), sandbox, { filename: f });
});
const { parseWhatsApp, resolveLocator_, normalizeDate_, docxXmlToText_,
        sliceChatByDate_, filterByDates_, mergeByDate_, runComparison,
        normalizeProductivity_, productivityFromRecords_, areaFromSection_,
        uniqCodes_, sumConcreteM3_ } = sandbox;

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok  - ' + msg); }
  else { console.log('  FAIL- ' + msg); failures++; }
}

console.log('\nLocator + date + docx:');
assert(normalizeDate_('5/8/26') === '2026-08-05', '"5/8/26" -> 2026-08-05');
assert(resolveLocator_('Sec-C/ER15(Mb)\nDwall works').area === 'Sec-C/Mb', '"Sec-C/ER15(Mb)" -> Sec-C/Mb');
assert(resolveLocator_('Sec-D/EI12/ CHCI').area === 'Sec-D/EI12', 'structure code EI12 -> Sec-D/EI12');
const dt = docxXmlToText_('<w:p><w:r><w:t>Date: 28 Aug</w:t></w:r></w:p><w:p><w:r><w:t>Manpower &amp; 6</w:t></w:r></w:p>');
assert(/Date: 28 Aug/.test(dt) && dt.indexOf('&amp;') === -1, 'docx xml -> text (paragraphs, entity unescaped)');

console.log('\nParsing + area groups:');
const rto0 = parseWhatsApp(fs.readFileSync(path.join(root, 'samples', 'rto.sample.txt'), 'utf8'), 'RTO');
assert(rto0.length >= 3, 'RTO sample parses records (got ' + rto0.length + ')');
assert(rto0.some(r => r.areaGroup), 'records carry an areaGroup (Area 1-4)');

console.log('\nDate scoping + accumulation helpers:');
const multiDay =
  '[5/8/26, 10:00:00] ~ Eng: Sec-C/Mb\nDW1 works\n' +
  '[6/8/26, 10:00:00] ~ Eng: Sec-D/Ub\nBase slab\n';
assert(parseWhatsApp(sliceChatByDate_(multiDay, ['2026-08-05']), 'RTO').length === 1, 'sliceChatByDate keeps one day');
assert(filterByDates_(parseWhatsApp(multiDay, 'RTO'), ['2026-08-06']).length === 1, 'filterByDates keeps the chosen date');
const merged = mergeByDate_([['2026-08-05', 'a'], ['2026-08-04', 'keep']], [['2026-08-05', 'new']], 0);
assert(merged.length === 2 && merged.some(r => r[1] === 'keep') && merged.some(r => r[1] === 'new'),
  'mergeByDate replaces the upload date, keeps other days');
// Regression: existing rows come back from Sheets as Date objects, new rows are
// ISO strings — they must still be recognised as the same day (no append-dup).
const mergedTyped = mergeByDate_([[new Date(2026, 7, 22), 'old']], [['2026-08-22', 'new']], 0);
assert(mergedTyped.length === 1 && mergedTyped[0][1] === 'new',
  'mergeByDate dedupes a Date-object day against the same ISO-string day');

console.log('\nProductivity metric helpers:');
assert(sumConcreteM3_('cast 42 m3 and 30 m³ today') === 72, 'sumConcreteM3 sums m3 + m³ (got ' + sumConcreteM3_('cast 42 m3 and 30 m³ today') + ')');
assert(uniqCodes_(['DW04', 'dw04', 'DW 04']).length === 1, 'uniqCodes dedupes case/space-insensitively');

console.log('\nArea auto-fill from section code (site-plan map):');
assert(areaFromSection_('Sec-C/Mb') === 'Area 2', 'Mb -> Area 2');
assert(areaFromSection_('Sec-D/Ub') === 'Area 3', 'Ub -> Area 3');
assert(areaFromSection_('Ja') === 'Area 1', 'Ja -> Area 1');
assert(areaFromSection_('.../P5') === 'Area 4', 'P5 -> Area 4 (not P/Area 2)');
assert(areaFromSection_('CUBE 8 (Qb)') === 'Area 1', 'Qb inside free text -> Area 1');
assert(areaFromSection_('Sec-D/EI12') === '', 'unmapped code -> "" (blank)');
assert(areaFromSection_('Area 3') === 'Area 3', 'already "Area 3" kept');

console.log('\nArea auto-fill applied by the normaliser (missing area filled):');
const na = normalizeProductivity_({
  date: '2026-08-22',
  mergedActivities: [
    { area: '', section: 'Sec-C/Mb', activity: 'Dwall', manpower: 5 },   // missing -> Area 2
    { area: 'Area 9', section: 'La2', activity: 'Slab', manpower: 3 }     // wrong -> corrected to Area 4
  ],
  productivityData: {}
}, '', 'ai');
assert(na.mergedActivities[0].area === 'Area 2', 'blank area filled from Mb -> Area 2');
assert(na.mergedActivities[1].area === 'Area 4', 'wrong area corrected from La2 -> Area 4');

console.log('\nProductivity AI normaliser (counts recomputed from arrays):');
const norm = normalizeProductivity_({
  date: '5/8/26',
  mergedActivities: [{ area: 'Area 2', section: 'Sec-C/Mb', activity: 'Dwall', manpower: 10 }, { activity: '' }],
  productivityData: {
    activeDWalls: ['DW1547', 'DW1547', 'DW04'], dWallCount: 99,   // wrong count -> recomputed
    activeBoredPiles: ['BP-T9-3'], activeButtressWalls: ['BT20-2'], activeCrossWalls: ['CW323'],
    totalConcreteVolumeM3: 84, totalManpower: 0
  }
}, '', 'ai');
assert(norm.date === '2026-08-05', 'summary date normalised to ISO');
assert(norm.productivityData.dWallCount === 2, 'dedupe + recompute dWallCount (99 -> 2)');
assert(norm.productivityData.bPileCount === 1 && norm.productivityData.cWallCount === 1, 'BP/CW counts from arrays');
assert(norm.mergedActivities.length === 1, 'empty-activity entries dropped');
assert(norm.productivityData.totalManpower === 10, 'totalManpower defaults to sum of activity manpower');

console.log('\nProductivity fallback (no AI) from real-ish text:');
const rto = '[5/8/26, 10:00:00] ~ Eng: Sec-C/Mb\nDW1547 rebar fixing; DW04 concrete casting 42 m3\nManpower: 10\n' +
            '[5/8/26, 10:05:00] ~ Eng: Sec-D/Ub\nBT20-2 excavation and CW323 kicker\nManpower: 8 pax\n';
const ais = '[5/8/26, 11:05:00] ~ AIS: Sec-A/Ja\nBP-T9-3 boring works, T9-3 pile\nManpower - 5\n';
const fb = productivityFromRecords_(rto, ais, '2026-08-05');
assert(fb.source === 'fallback', 'fallback marked source=fallback');
assert(fb.date === '2026-08-05', 'fallback uses the report date');
assert(fb.mergedActivities.length === 3, 'merged 3 activities (Mb, Ub, Ja)');
assert(fb.productivityData.dWallCount === 2, 'DW count = 2 (DW1547, DW04)');
assert(fb.productivityData.bPileCount === 2, 'BP count = 2 (BP-T9-3, T9-3)');
assert(fb.productivityData.bWallCount === 1, 'BT count = 1 (BT20-2)');
assert(fb.productivityData.cWallCount === 1, 'CW count = 1 (CW323)');
assert(fb.productivityData.totalConcreteVolumeM3 === 42, 'concrete m3 = 42');
assert(fb.productivityData.totalManpower === 23, 'manpower = 10+8+5 = 23 (got ' + fb.productivityData.totalManpower + ')');

console.log('\nrunComparison end-to-end (offline productivity):');
const rc = runComparison(rto, ais, '2026-08-05');
assert(rc.reportDate === '2026-08-05', 'runComparison reports the date');
assert(rc.productivityData && rc.productivityData.dWallCount === 2, 'runComparison returns productivityData');
assert(Array.isArray(rc.mergedActivities) && rc.mergedActivities.length === 3, 'runComparison returns mergedActivities');

console.log('\n' + (failures ? (failures + ' FAILED') : 'ALL PASSED'));
process.exit(failures ? 1 : 0);
