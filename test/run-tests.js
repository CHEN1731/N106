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
        normalizeProductivity_, productivityFromRecords_, buildProductivityResult_,
        areaFromSection_, normAreaName_, classifyElement_, firstElementId_,
        uniqCodes_, sumConcreteM3_, castVolumeOf_ } = sandbox;

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
assert(areaFromSection_('Sec-D/EI12') === 'Area 3', 'EI12 -> Area 3');
assert(areaFromSection_('P323') === '', 'unmapped code -> "" (blank)');
assert(areaFromSection_('Area 3') === 'Area 3', 'already "Area 3" kept');
// Section-letter fallback (records with only Sec-A..Sec-E)
assert(areaFromSection_('Sec-A') === 'Area 1', 'Sec-A -> Area 1');
assert(areaFromSection_('Sec-C') === 'Area 2', 'Sec-C -> Area 2');
assert(areaFromSection_('Section D') === 'Area 3', 'Section D -> Area 3');
assert(areaFromSection_('Sec-E') === 'Area 4', 'Sec-E -> Area 4');
assert(areaFromSection_('OPA') === 'Area 2', 'OPA -> Area 2');
assert(areaFromSection_('XR14') === 'Area 4', 'XR14 -> Area 4');
// Segment wins over the section letter when both are present.
assert(areaFromSection_('Sec-C/Sb') === 'Area 3', 'Sec-C/Sb -> segment Sb wins (Area 3)');

console.log('\nArea auto-fill applied by the normaliser (missing/blank areaName filled from section):');
const na = normalizeProductivity_({
  date: '2026-08-22',
  areas: [
    { areaName: '', kpiBreakdown: {}, activities: [
      { elementId: '', section: 'Sec-C/Mb', activityDescription: 'Dwall', manpower: 5, sourceEvidence: '' }   // -> Area 2
    ]},
    { areaName: '', kpiBreakdown: {}, activities: [
      { elementId: '', section: 'La2', activityDescription: 'Slab', manpower: 3, sourceEvidence: '' }          // -> Area 4
    ]}
  ],
  grandTotals: {}
}, '', 'ai');
assert(!!na.areas.filter(function(x){return x.areaName==='Area 2';}).length, 'blank areaName filled from Mb -> Area 2');
assert(!!na.areas.filter(function(x){return x.areaName==='Area 4';}).length, 'blank areaName filled from La2 -> Area 4');

console.log('\nElement + area helpers:');
assert(firstElementId_('lowering rebar cage for DW 1547 today') === 'DW1547', 'elementId parsed from text (DW 1547 -> DW1547)');
assert(firstElementId_('general housekeeping') === '', 'no element code -> ""');
assert(classifyElement_('DW04') === 'DW' && classifyElement_('BT20-2') === 'BT' && classifyElement_('CW323') === 'CW',
  'classifyElement DW/BT/CW');
assert(classifyElement_('BP-T9-3') === 'BP' && classifyElement_('T9-3') === 'BP', 'classifyElement BP (incl pile ref)');
assert(normAreaName_('area 2') === 'Area 2' && normAreaName_('Others') === 'Others' && normAreaName_('Sec-C') === '',
  'normAreaName maps Area N / Others / unknown');

console.log('\nConcrete casting rule (LSS excluded, X/Y -> X, latest per panel):');
assert(castVolumeOf_('LSS material backfilling 30 m3') === 0, 'LSS backfilling is not concrete casting -> 0');
assert(castVolumeOf_('backfill 25 m3') === 0, 'backfilling excluded -> 0');
assert(castVolumeOf_('DW1547 concreting 55/100 m3') === 55, '"55/100 m3" -> current cast 55');
assert(castVolumeOf_('concrete casting 42 m3') === 42, 'plain casting "42 m3" -> 42');
assert(castVolumeOf_('DW1547 rebar fixing 100 m3 formwork') === 0, 'no casting context -> 0 (not counted)');
// Per-panel: same panel reported twice -> count once at the latest/highest value.
const pc = normalizeProductivity_({
  date: '2026-08-22',
  areas: [{ areaName: 'Area 2', kpiBreakdown: {}, activities: [
    { elementId: 'DW1547', section: 'Sec-C/Mb', activityDescription: 'DW1547 concreting 40/100 m3', manpower: 5, sourceEvidence: '' },
    { elementId: 'DW1547', section: 'Sec-C/Mb', activityDescription: 'DW1547 concreting 100/100 m3', manpower: 6, sourceEvidence: '' }
  ]}],
  grandTotals: {}
}, '', 'ai');
assert(pc.areas[0].kpiBreakdown.concreteVolumeM3 === 100, 'same panel counted once at latest (100), not 40+100');
assert(pc.grandTotals.totalConcreteVolumeM3 === 100, 'grand concrete = 100 (deduped per panel)');

console.log('\nArea breakdown + back-check (KPI derived from activities):');
const se = normalizeProductivity_({
  date: '2026-08-22',
  areas: [
    { areaName: 'Area 2', kpiBreakdown: {}, activities: [
      { elementId: '', section: 'Sec-C/Mb', activityDescription: 'DW1547 concreting 84 m3', manpower: 6, sourceEvidence: 'raw dw1547 line' },
      { elementId: 'DW04', section: 'Sec-C/Mb', activityDescription: 'DW04 rebar', manpower: 4, sourceEvidence: '' }
    ]},
    { areaName: 'Area 3', kpiBreakdown: { concreteVolumeM3: 0 }, activities: [
      { elementId: 'BT20-2', section: 'Sec-D/Ub', activityDescription: 'BT20-2 excavation', manpower: 5, sourceEvidence: '' }
    ]}
  ],
  grandTotals: {}
}, '', 'ai');
assert(se.date === '2026-08-22', 'date passed through');
assert(se.areas.length === 2 && se.areas[0].areaName === 'Area 2', 'two areas, Area 2 first');
assert(se.areas[0].kpiBreakdown.dWallCount === 2 &&
  se.areas[0].kpiBreakdown.activeDWalls.join(',') === 'DW1547,DW04', 'Area 2 DW list derived from its activities');
assert(se.areas[0].kpiBreakdown.concreteVolumeM3 === 84, 'Area 2 concrete summed from activity text (84)');
assert(se.areas[0].kpiBreakdown.areaManpower === 10, 'Area 2 manpower = 6+4');
assert(se.areas[1].kpiBreakdown.bWallCount === 1, 'Area 3 BT count = 1');
assert(se.mergedActivities[0].elementId === 'DW1547', 'blank elementId backfilled from activity text');
assert(se.mergedActivities.length === 3 && !('status' in se.mergedActivities[0]), 'flattened activities, no status field');
assert(se.productivityData.dWallCount === 2 && se.grandTotals.totalManpower === 15, 'grand totals rolled up (DW=2, manpower=15)');

console.log('\nProductivity fallback (no AI) from real-ish text:');
const rto = '[5/8/26, 10:00:00] ~ Eng: Sec-C/Mb\nDW1547 rebar fixing; DW04 concrete casting 42 m3\nManpower: 10\n' +
            '[5/8/26, 10:05:00] ~ Eng: Sec-D/Ub\nBT20-2 excavation and CW323 kicker\nManpower: 8 pax\n';
const ais = '[5/8/26, 11:05:00] ~ AIS: Sec-A/Ja\nBP-T9-3 boring works, T9-3 pile\nManpower - 5\n';
const fb = productivityFromRecords_(rto, ais, '2026-08-05');
function areaOf(res, name){ for (var i=0;i<res.areas.length;i++) if (res.areas[i].areaName===name) return res.areas[i]; return null; }
assert(fb.source === 'fallback', 'fallback marked source=fallback');
assert(fb.date === '2026-08-05', 'fallback uses the report date');
assert(fb.mergedActivities.length === 3, 'merged 3 activities (Mb, Ub, Ja)');
assert(fb.areas.map(a => a.areaName).join(',') === 'Area 1,Area 2,Area 3', 'areas grouped + ordered (1,2,3)');
assert(areaOf(fb,'Area 2').kpiBreakdown.dWallCount === 2, 'Area 2 (Mb) DW count = 2 (DW1547, DW04)');
assert(areaOf(fb,'Area 1').kpiBreakdown.bPileCount === 2, 'Area 1 (Ja) BP count = 2 (BP-T9-3, T9-3)');
assert(fb.productivityData.dWallCount === 2, 'grand DW count = 2');
assert(fb.productivityData.bPileCount === 2, 'grand BP count = 2');
assert(fb.productivityData.totalConcreteVolumeM3 === 42, 'grand concrete m3 = 42');
assert(fb.productivityData.totalManpower === 23, 'grand manpower = 10+8+5 = 23 (got ' + fb.productivityData.totalManpower + ')');
assert(fb.mergedActivities[0].elementId === 'DW1547' && typeof fb.mergedActivities[0].sourceEvidence === 'string',
  'fallback activity carries elementId + sourceEvidence');

console.log('\nrunComparison end-to-end (offline productivity):');
const rc = runComparison(rto, ais, '2026-08-05');
assert(rc.reportDate === '2026-08-05', 'runComparison reports the date');
assert(Array.isArray(rc.areas) && rc.areas.length === 3, 'runComparison returns area breakdown');
assert(rc.productivityData && rc.productivityData.dWallCount === 2, 'runComparison returns grand productivityData');
assert(Array.isArray(rc.mergedActivities) && rc.mergedActivities.length === 3, 'runComparison returns mergedActivities');

console.log('\n' + (failures ? (failures + ' FAILED') : 'ALL PASSED'));
process.exit(failures ? 1 : 0);
