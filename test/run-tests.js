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
['Parser.gs', 'Compare.gs', 'Extract.gs', 'Docx.gs', 'Code.gs', 'Webhook.gs'].forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(root, 'gas', f), 'utf8'), sandbox, { filename: f });
});
const { parseWhatsApp, resolveLocator_, stripMedia_, normalizeDate_, detectDateOrder_, resolveDateOrder_, splitActivityItems_, isSubcontractorHeader_, docxXmlToText_,
        sliceChatByDate_, filterByDates_, mergeByDate_, runComparison,
        normalizeProductivity_, productivityFromRecords_, buildProductivityResult_, isRosterLine_,
        mergeProductivity_, activityCovered_, backfillWorthy_, isPlanningNoise_, mergeSameWork_,
        areaFromSection_, normAreaName_, classifyElement_, firstElementId_, normElId_,
        uniqCodes_, sumConcreteM3_, castVolumeOf_, stageFromText_,
        parseWebhookMessages_, phoneSource_, normalizePhone_,
        waTimestampToDate_, buildDayTexts_, toDateStr_,
        normalizeMachineStatus_, machineTrigger_, machineStateFor_, machineStateFromEvidence_, mentionsMachine_, machineEvidence_,
        lifecycleStageFor_, elementStageForward_, clampLifecycle_, collapseByLocation_, displaySection_, segmentsOnLine_, isNoActivityOnly_,
        normalizeExcavation_, normalizeRC_, classifyRcType_, parseDepthM_, parseLoads_, firstManpower_, groutingArea_ } = sandbox;

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok  - ' + msg); }
  else { console.log('  FAIL- ' + msg); failures++; }
}

// Baseline the suite as an "auto" (no configured order) site so the existing ambiguous/sample
// fixtures (which treat "5/8/26" as a D/M/Y day -> Aug 5) stay valid. The live deployment ships
// PARSER_CONFIG.dateOrder='mdy'; a dedicated build-64 block below exercises that explicitly.
sandbox.PARSER_CONFIG.dateOrder = '';

// Baseline the suite at per-WORK granularity so the existing per-activity count assertions stay
// valid. The live deployment ships PARSER_CONFIG.activityGranularity='location' (one row per
// location); a dedicated build-70 block below exercises that collapse explicitly.
sandbox.PARSER_CONFIG.activityGranularity = 'work';

console.log('\nLocator + date + docx:');
assert(normalizeDate_('5/8/26') === '2026-08-05', '"5/8/26" (ambiguous) -> 2026-08-05 (D/M/Y default)');
assert(normalizeDate_('9/25/26') === '2026-09-25', '"9/25/26" (2nd>12) -> 2026-09-25 (M/D/Y)');
assert(normalizeDate_('25/9/26') === '2026-09-25', '"25/9/26" (1st>12) -> 2026-09-25 (D/M/Y)');
assert(normalizeDate_('5/8/26', 'mdy') === '2026-05-08', '"5/8/26" with mdy order -> 2026-05-08');
assert(normalizeDate_('2026-09-25') === '2026-09-25', 'already-ISO date returned unchanged');
assert(detectDateOrder_(['[9/25/26, 10:00:00] ~ Eng: hi']) === 'mdy', 'detectDateOrder_ -> mdy for 9/25 export');
assert(detectDateOrder_(['[25/9/26, 10:00:00] ~ Eng: hi']) === 'dmy', 'detectDateOrder_ -> dmy for 25/9 export');
assert(detectDateOrder_(['[5/8/26, 10:00:00] ~ Eng: hi']) === '', 'detectDateOrder_ -> "" when ambiguous');
// build-59: the ISO report date breaks the tie for an ambiguous single-day file (e.g. Oct 2 = "10/2/26")
const ambigOct2 = ['[10/2/26, 8:00:00 AM] ~ Eng: Sec-A/Ja', 'DW01 rebar', 'Manpower: 5'];
assert(resolveDateOrder_(ambigOct2, '2026-10-02') === 'mdy', 'resolveDateOrder_ -> mdy when target 2026-10-02 matches M/D/Y');
assert(resolveDateOrder_(ambigOct2, '2026-02-10') === 'dmy', 'resolveDateOrder_ -> dmy when target 2026-02-10 matches D/M/Y');
assert(resolveDateOrder_(ambigOct2, '') === '', 'resolveDateOrder_ -> "" with no target (D/M/Y default preserved)');
assert(resolveDateOrder_(['[9/25/26, 10:00:00] ~ Eng: hi'], '2026-01-01') === 'mdy', 'resolveDateOrder_ trusts an unambiguous file over the target');
assert(parseWhatsApp('[10/2/26, 8:00:00 AM] ~ Eng: Sec-A/Ja\nDW01 rebar\nManpower: 5\n', 'RTO', 'mdy')[0].date === '2026-10-02', 'parseWhatsApp honours an explicit mdy order (Oct 2)');

// build-64: a configured site dateOrder = 'mdy' resolves ambiguous headers (10/6 = Oct 6) with NO
// picker date, while in-body hand-typed "Date:" (no order) stays D/M/Y, and a field>12 still wins.
(function () {
  sandbox.PARSER_CONFIG.dateOrder = 'mdy';
  try {
    assert(resolveDateOrder_(['[10/6/26, 1:00:00 AM] +65 9 1595: hi'], '') === 'mdy',
      'mdy config: ambiguous header + no target -> mdy');
    assert(parseWhatsApp('[10/6/26, 1:00:00 AM] +65 9 1595: Sec-A/Ja\nDW01 1st bite 5m\n', 'RTO')[0].date === '2026-10-06',
      'mdy config: "10/6/26" header -> 2026-10-06 (no picker)');
    assert(resolveDateOrder_(['[25/9/26, 10:00:00] ~ Eng: hi'], '') === 'dmy',
      'mdy config: a field>12 (25/9) still auto-detects dmy (detect wins over config)');
    assert(normalizeDate_('05/10/2026') === '2026-10-05',
      'mdy config: in-body "Date:05/10/2026" (no order) stays Oct 5 (D/M/Y, unaffected by config)');
  } finally { sandbox.PARSER_CONFIG.dateOrder = ''; }
})();
// Regression (the live bug): a single-day Oct-2 M/D/Y file + picker target 2026-10-02 keeps the day,
// instead of filterByDates_ dropping everything to ~0.
(function () {
  var oct2 = '';
  for (var i = 0; i < 8; i++) oct2 += '[10/2/26, ' + (8 + i) + ':00:00 AM] ~ Eng: Sec-A/Ja\nDW' + i + ' rebar works\nManpower: 3\n';
  var kept = productivityFromRecords_(oct2, '', '2026-10-02');
  assert(kept.mergedActivities.length === 8, 'single-day Oct-2 file keeps all 8 activities (got ' + kept.mergedActivities.length + ')');
  assert(kept.mergedActivities.every(function (a) { return a; }) && kept.date === '2026-10-02', 'the kept day is dated 2026-10-02');
})();
assert(resolveLocator_('Sec-C/ER15(Mb)\nDwall works').area === 'Sec-C/ER15', '"Sec-C/ER15(Mb)" -> Sec-C/ER15 (ER## now matched as a segment)');
assert(resolveLocator_('Sec-C/ER15(Mb)\nDwall works').areaGroup === 'Area 2', 'ER15 -> Area 2');
(function () {
  var er = resolveLocator_('Sec C/ER15(Le2)/LT Sambo\nDwall excavation');
  assert(er.section === 'Sec-C' && er.segment === 'ER15' && er.area === 'Sec-C/ER15' && er.areaGroup === 'Area 2',
    '"Sec C/ER15(Le2)/LT Sambo" -> Sec-C/ER15, Area 2 (got ' + JSON.stringify(er) + ')');
})();
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
// build-48: Section-N + "Under PIE CM" are Area 2 (BTC canal / tunnel + Under-PIE works)
assert(areaFromSection_('N') === 'Area 2', 'N -> Area 2 (moved from Area 1)');
assert(areaFromSection_('Sec-N') === 'Area 2', 'Sec-N -> Area 2');
assert(areaFromSection_('Under PIE CM') === 'Area 2', 'Under PIE CM -> Area 2');
assert(resolveLocator_('Sec-N(N2&N3)\nExcavation work in progress').areaGroup === 'Area 2',
  'a header leading with Sec-N now resolves (was dropped) -> Area 2');
assert(resolveLocator_('Under PIE CM / SCT\nExcavation work').areaGroup === 'Area 2',
  'a header leading with Under PIE CM now resolves -> Area 2');
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
// A casting figure must survive when the same activity also mentions LSS backfilling.
assert(castVolumeOf_('concrete casting complete 54/54 m3 + LSS backfilling') === 54,
  'casting 54/54 + LSS backfilling -> 54 (backfill clause dropped, not the whole activity)');
assert(castVolumeOf_('LSS backfilling, concrete casting 30 m3') === 30, 'casting clause kept, LSS clause dropped');
assert(castVolumeOf_('LSS material backfilling 20 m3 + soil compaction') === 0, 'pure backfill activity -> 0');
// LSS backfilling itself reported in X/Y form must NOT be counted as concrete.
assert(castVolumeOf_('Concrete casting completed 54/54m3, then LSS Type-3 backfilling in progress reaching 100/107m3') === 54,
  'casting 54/54 + LSS backfilling 100/107 -> 54 (LSS X/Y excluded)');
// Unit on BOTH sides of the slash, comma splitting keyword from figure, theoretical ignored.
assert(castVolumeOf_('BP casting works completed, actual volume 84.0m3/84.0m3 (theoretical 76.43m3, overbreak 9.9%)') === 84,
  'BP 84.0m3/84.0m3 -> 84 (theoretical 76.43 ignored)');
assert(castVolumeOf_('Concrete casting completed, actual volume 200m3/202m3 (theoretical 178.848m3, overbreak 12.94%)') === 200,
  'Concrete 200m3/202m3 -> 200 (theoretical ignored)');
assert(castVolumeOf_('RCBC drain wall and top slab casting completed, concrete G40 9m3') === 9,
  'RCBC plain casting "concrete G40 9m3" -> 9');
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

console.log('\nConstruction stage classifier:');
assert(stageFromText_('Guide wall casting') === 'Concrete Casting', 'guide wall + casting -> furthest (Concrete Casting)');
assert(stageFromText_('DW1547 guide wall works') === 'Guide Wall', 'guide wall only -> Guide Wall');
assert(stageFromText_('excavation ongoing') === 'Excavation', 'excavation -> Excavation');
assert(stageFromText_('lowering rebar cage') === 'Rebar Cage', 'rebar cage -> Rebar Cage');
assert(stageFromText_('concrete casting 54/54 completed') === 'Completed', 'casting completed -> Completed');
assert(stageFromText_('excavation completed') === 'Excavation', 'excavation completed -> Excavation (not Completed)');
assert(stageFromText_('trimming works') === 'Trimming', 'trimming -> Trimming');
assert(stageFromText_('hacking pile head') === 'Breaking', 'hacking -> Breaking');
assert(stageFromText_('site meeting') === 'Other', 'no stage keyword -> Other');
// Stage carried through the normaliser + fallback
const stg = normalizeProductivity_({ date:'2026-08-22', areas:[{ areaName:'Area 2', kpiBreakdown:{}, activities:[
  { elementId:'DW1', section:'Sec-C/Mb', activityDescription:'DW1 excavation ongoing', manpower:5 }
]}], grandTotals:{} }, '', 'ai');
assert(stg.areas[0].activities[0].stage === 'Excavation', 'normaliser fills stage from activity text');
assert(stg.mergedActivities[0].stage === 'Excavation', 'mergedActivities carry stage');

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
assert(areaOf(fb,'Area 1').kpiBreakdown.bPileCount === 1, 'Area 1 (Ja) BP count = 1 (BP-T9-3 == T9-3, deduped)');
assert(fb.productivityData.dWallCount === 2, 'grand DW count = 2');
assert(fb.productivityData.bPileCount === 1, 'grand BP count = 1 (BP-T9-3 == T9-3)');
assert(fb.productivityData.totalConcreteVolumeM3 === 42, 'grand concrete m3 = 42');
assert(fb.productivityData.totalManpower === 23, 'grand manpower = 10+8+5 = 23 (got ' + fb.productivityData.totalManpower + ')');
assert(fb.mergedActivities[0].elementId === 'DW1547' && !('sourceEvidence' in fb.mergedActivities[0]),
  'fallback activity carries elementId, no sourceEvidence');

console.log('\nCarry-forward locator (build-60): short location-less updates attach to the last location:');
// A short update with no Sec-x header (even one naming an element, e.g. "DW05 concrete casting")
// must attach to the most recent real location, not be dropped. Pure chatter is still dropped,
// and a location-less line BEFORE any located report is still dropped.
const cf = productivityFromRecords_([
  '[9/25/26, 8:00:00 AM] ~ Eng: Good morning, please share updates',  // leading chatter (no prior loc)
  '[9/25/26, 8:10:00 AM] ~ Eng: Sec-A/Ja',
  'Roof slab rebar fixing ongoing',
  'Manpower: 10',
  '[9/25/26, 8:30:00 AM] ~ Eng: Backfilling works ongoing',           // carried -> Area 1
  '[9/25/26, 9:00:00 AM] ~ Eng: DW05 concrete casting 42m3',          // carried -> Area 1 (element kept)
  '[9/25/26, 9:30:00 AM] ~ Eng: Soil disposal 3 loads',               // carried -> Area 1
  '[9/25/26, 9:45:00 AM] ~ Eng: Thanks all, good job today',          // chatter -> dropped
  '[9/25/26, 10:00:00 AM] ~ Eng: Sec-C/Mb',
  'BP U7-3 boring works depth 23m',
  'Manpower: 8'
].join('\n'), '', '2026-09-25');
function areaCF(res, name){ for (var i=0;i<res.areas.length;i++) if (res.areas[i].areaName===name) return res.areas[i]; return null; }
assert(cf.mergedActivities.length === 5, 'carry-forward keeps all 5 activities (2 located + 3 carried), chatter dropped (got ' + cf.mergedActivities.length + ')');
assert(cf.mergedActivities.some(a => /DW05 concrete casting/.test(a.activity) && a.area === 'Area 1'),
  'the element line "DW05 concrete casting" is kept under Area 1 (carried), not dropped');
assert(cf.mergedActivities.some(a => /Soil disposal 3 loads/.test(a.activity) && a.area === 'Area 1'),
  '"Soil disposal 3 loads" carried to Area 1 (not Others)');
assert(!cf.mergedActivities.some(a => /Good morning|Thanks all/.test(a.activity)), 'chatter lines are not activities');
assert(areaCF(cf, 'Area 2') && areaCF(cf, 'Area 2').activities.length === 1, 'Sec-C paragraph stays its own Area 2 activity');

console.log('\nImage-header locator + own-section (build-61): no carry-forward smear, clean media strip:');
// This export carries the location on the "<image omitted>" line and sections resolve with an
// EMPTY areaGroup (segment unmapped). A message with its OWN section must use it, NOT inherit the
// previous message's area (the build-60 regression). Media markers strip cleanly (no "<>").
assert(stripMedia_('<image omitted> Sec C/ER15(Le2)/LT Sambo').indexOf('<>') === -1,
  'stripMedia_ leaves no "<>" from "<image omitted>"');
assert(/^Sec C\/ER15/.test(stripMedia_('<image omitted> Sec C/ER15(Le2)/LT Sambo')),
  'stripMedia_ yields the clean location line');
assert(resolveLocator_(stripMedia_('<image omitted> Sec C/ER15(Le2)')).section === 'Sec-C',
  'locator resolves Sec-C from an image-prefixed header');
const imgFile = [
  '[10/2/26, 1:00:00 AM] +65 9000 0001: <image omitted> Sec-D/CCL/Ub/NB/Base Slab/Kian Hup:',
  '- Mass concrete casting completed',
  '[10/2/26, 1:05:00 AM] +65 9000 0002: <image omitted> Sec A/Singtel ex-bldg (Kb1)/Lt Sambo',
  'DW592 2nd bite excavation in progress',
  '[10/2/26, 1:10:00 AM] +65 9000 0003: <image omitted> Sec E/Whitley Rd /Dyson Island/ LT Sambo',
  '- Preparation work for Silos dismantling',
  '[10/2/26, 1:15:00 AM] +65 9000 0004: <image omitted> RTO area arrangement (2026-Oct-03) Aravind, Kyaw, Karthik'
].join('\n');
const imgRes = productivityFromRecords_(imgFile, '', '2026-10-02');
function areaOfAct(res, kw){ var a = res.mergedActivities.find(x => new RegExp(kw, 'i').test(x.activity)); return a ? a.area : null; }
assert(areaOfAct(imgRes, 'DW592') === 'Area 1', 'Sec-A/Singtel (empty areaGroup) uses its OWN section -> Area 1, not carried to Area 3 (got ' + areaOfAct(imgRes, 'DW592') + ')');
assert(areaOfAct(imgRes, 'Silos') === 'Area 4', 'Sec-E/Whitley uses its own section -> Area 4 (got ' + areaOfAct(imgRes, 'Silos') + ')');
assert(areaOfAct(imgRes, 'Mass concrete') === 'Area 3', 'Sec-D -> Area 3');
assert(!imgRes.mergedActivities.some(a => /<>/.test(a.activity)), 'no "<>" leaks into any activity');
assert(!imgRes.mergedActivities.some(a => /rto area arrangement/i.test(a.activity)), 'the RTO area-arrangement planning banner is not an activity');

console.log('\nTAM grouting report (build-65): kept as one clean activity, banner stripped:');
// A TAEHWA GEO / TAM grouting survey must NOT be dropped as "noise" and must not shred into a bare
// banner row — it is one grouting activity at its LOCATION (QC1 -> Area 2).
var groutMsg = [
  '[10/6/26, 12:48:32 AM] +65 9 1595: <image omitted> NORTH SOUTH CORRIDOR(N106)',
  'TAEHWA GEO ENGR',
  'LOCATION:QC1',
  'TAM GROUTING WORK',
  'Date:05/10/2026',
  '(Night Shift)',
  'BH NO:DW-428-T2',
  'Dia:1.2m',
  'Total Improvement Length:6.0m',
  'Depth : 17.11M'
].join('\n');
var gRes = productivityFromRecords_(groutMsg, '', '');
assert(gRes.mergedActivities.length === 1, 'grouting report -> exactly one activity (got ' + gRes.mergedActivities.length + ')');
var gAct = gRes.mergedActivities[0] || {};
assert(/TAM GROUTING WORK/i.test(gAct.activity || '') && /DW-?428/i.test(gAct.activity || ''), 'the grouting activity keeps the work (TAM GROUTING + DW-428)');
assert(gAct.area === 'Area 2', 'grouting at LOCATION:QC1 classifies to Area 2 (got ' + gAct.area + ')');
assert(!/^(north south corridor|taehwa geo engr location\s*[:\-]?)\s*$/i.test((gAct.activity || '').trim()), 'the activity is not a bare banner');
// the filter now only drops the genuine roster/status banners, not grouting companies
assert(isPlanningNoise_('RTO area arrangement (2026-Oct) Aravind, Kyaw') === true, 'isPlanningNoise_ still drops the RTO roster');
assert(isPlanningNoise_('TAEHWA GEO ENGR LOCATION:QC1 TAM GROUTING WORK DW-428 depth 17m') === false, 'isPlanningNoise_ no longer drops a grouting report');

console.log('\nM/D/Y export (build-47): dates + traffic/diversion kept:');
// A US-order export (2nd field 25 can only be a day) must resolve to 2026-09-25,
// and a new traffic-diversion (TD 3A-7) line must survive to the merged activities.
const mdyExport =
  '[9/25/26, 09:00:00] ~ Eng: Sec-C/Mb\nDW1600 1st bite 12.5m\nManpower: 6\n' +
  '[9/25/26, 09:30:00] ~ Eng: Sec-C/Mb\nTD 3A-7 steel decking install for new traffic diversion, lane closed\nManpower: 4\n';
const mdyRecs = parseWhatsApp(mdyExport, 'RTO');
assert(mdyRecs.length >= 2 && mdyRecs.every(r => r.date === '2026-09-25'),
  'M/D/Y export records all date to 2026-09-25 (got ' + mdyRecs.map(r => r.date).join(',') + ')');
const mdyFb = productivityFromRecords_(mdyExport, '', '2026-09-25');
assert(mdyFb.mergedActivities.some(a => /3A-7|decking|diversion/i.test((a.activity || a.activityDescription || ''))),
  'offline path keeps the TD 3A-7 traffic-diversion activity');

console.log('\nSplit by sub-heading, combine lines within (build-74; restored from build-61):');
// One heading's bullets / measurements (no sub-contractor sub-header) -> ONE activity.
assert(splitActivityItems_(['- Cleaning work.', '- T1 & T2 tying work.', '- W5 starter bar installation work.']).length === 1,
  'a one-heading 3-bullet list -> 1 activity (lines combined)');
assert(splitActivityItems_(['BT27-1(1.0 x 2.8m)', '- LSS Type 3 backfilling in progress', '- Running volume:57/80m3']).length === 1,
  'activity + its measurement bullet -> 1 activity');
assert(splitActivityItems_(['DW1547 rebar fixing']).length === 1, 'single line -> 1 item');
// Different sub-contractor sub-headers DO split; lines under each are combined.
(function () {
  var two = splitActivityItems_(['SCT', 'Exposing 150mm dia WP', 'Huationg', 'Soil disposal works']);
  assert(two.length === 2, 'two sub-contractor sub-headers -> 2 activities (split by sub-heading)');
  assert(/Exposing 150mm dia WP/.test(two[0]) && /Soil disposal works/.test(two[1]),
    'each sub-heading keeps its own work');
})();
assert(isSubcontractorHeader_('SCT') && isSubcontractorHeader_('Huationg') && isSubcontractorHeader_('SCT /MSK'),
  'sub-contractor names are recognised as sub-headers');
assert(!isSubcontractorHeader_('North Cell') && !isSubcontractorHeader_('Roof Slab') && !isSubcontractorHeader_('Manpower SCT - 13'),
  'cell labels / headings / inline-SCT are NOT sub-contractor headers');
const multiMsg =
  '[9/25/26, 09:00:00] ~ Eng: Sec-C/Mb\n' +
  '- DW1547 rebar cage lowering\n- DW04 concrete casting 42 m3\n* BT20-2 excavation ongoing\nManpower: 9\n';
const multiRec = parseWhatsApp(multiMsg, 'RTO');
assert(multiRec.length === 1 && multiRec[0].activityItems.length === 1,
  'a one-heading 3-bullet message -> 1 merged activityItem (got ' + (multiRec[0] && multiRec[0].activityItems.length) + ')');
const multiFb = productivityFromRecords_(multiMsg, '', '2026-09-25');
assert(multiFb.mergedActivities.length === 1, 'offline path emits 1 merged activity from the 3-bullet message (got ' + multiFb.mergedActivities.length + ')');
assert(multiFb.productivityData.totalManpower === 9, 'manpower counted once (9) (got ' + multiFb.productivityData.totalManpower + ')');

console.log('\nXR14 glued AREA-tag header + roster filter (build-50):');
// "AREA-4.XR14 -FB" must expose the XR14 segment (period now splits) -> Area 4.
assert(resolveLocator_('AREA-4.XR14 -FB\n- Noise mitigation').areaGroup === 'Area 4',
  'glued "AREA-4.XR14" header resolves to Area 4 (was dropped)');
// A forwarded daily-manpower block: real activities kept, roster/machinery counts dropped.
const fwdMsg =
  '[9/25/26, 09:20:51 AM] ~ Eng: [Forwarded] DAILY MANPOWER AND ACTIVITIES\n' +
  'AREA-4.XR14 -FB\n25/09/2026\nDAY SHIFT\nSAMSUNG ACTIVITIES\n' +
  '- Noise mitigation installation and monitoring\n- Hard Barricade Install\n- Traffic control\n' +
  'Manpower SCT - 13\n- SUPERVISOR-1\n- General worker -5\n- Crane - 1 SCT\n- Excavators -0\n';
const fwd = productivityFromRecords_(fwdMsg, '', '2026-09-25');
const fwdActs = fwd.mergedActivities.map(a => a.activity);
assert(fwd.mergedActivities.every(a => a.area === 'Area 4'), 'forwarded XR14 block grouped under Area 4');
assert(fwdActs.some(a => /noise mitigation/i.test(a)) && fwdActs.some(a => /hard barricade/i.test(a)) && fwdActs.some(a => /traffic control/i.test(a)),
  'real activities (noise mitigation, hard barricade, traffic control) are kept');
assert(!fwdActs.some(a => /^supervisor-1|^general worker -5|^crane - 1|^excavators -0/i.test(a)),
  'roster/machinery counts (SUPERVISOR-1, General worker -5, Crane -1, Excavators -0) are dropped');
// isRosterLine_ precision: real activities are never flagged
assert(!isRosterLine_('Traffic control') && !isRosterLine_('Lifting work') && !isRosterLine_('Crane lifting rebar cage') && !isRosterLine_('Excavator shift to QC island'),
  'isRosterLine_ keeps real activities');
assert(isRosterLine_('SUPERVISOR-1') && isRosterLine_('General worker -5') && isRosterLine_('Excavators -0') && isRosterLine_('Foreman :'),
  'isRosterLine_ flags roster counts');

console.log('\nSplit a message by sub-contractor sub-heading (build-74; restored from build-61):');
// One location, two sub-contractors (HTC / SCT): the lead + each sub-contractor are SEPARATE
// activities, each classified to Area 1, and the SCT work is NOT glued onto the HTC activity.
const spcMsg =
  '[9/25/26, 10:00:00 AM] ~ Eng: Sec A/SPC/CM(Ja)/Huationg & SCT/\n' +
  'Roof Slab (NB-CH4220 to CH4305)\nCurrent Excavation depth:4.50m/4.50m\n' +
  ' HTC \n- Excavation and soil disposal work ongoing to gate #33 \n' +
  ' SCT \n- 300mm water pipe support installation.\n';
const spc = productivityFromRecords_(spcMsg, '', '2026-09-25');
assert(spc.mergedActivities.length === 3, 'the SPC/HTC/SCT message -> 3 activities (lead + HTC + SCT) (got ' + spc.mergedActivities.length + ')');
assert(spc.mergedActivities.every(a => a.area === 'Area 1'), 'all SPC activities classified to Area 1');
const spcWater = spc.mergedActivities.find(a => /water pipe/i.test(a.activity));
const spcSoil = spc.mergedActivities.find(a => /soil disposal/i.test(a.activity));
assert(spcWater && !/soil disposal/i.test(spcWater.activity), 'the SCT water-pipe work is its own activity (not glued to HTC)');
assert(spcSoil && !/water pipe/i.test(spcSoil.activity), 'the HTC soil-disposal work is its own activity');

console.log('\nSplit by sub-heading even without bullets (build-74):');
// Sub-contractor sub-headers (SCT / Huationg) with no bullets still delimit separate activities.
const spcNoBul =
  '[9/25/26, 10:00:00 AM] ~ Eng: Sec A/SPC/CM(Ja)/Huationg & SCT/\n' +
  '-\tRoof Slab (NB-CH4220 to CH4305)\n' +
  'Deck soffit lvl 4.050mSHD to -0.134mSHD Mining Excavation from S02 to S01\n' +
  'Current Excavation depth:4.50m/4.50m\n' +
  'SCT\nExposing 150mm dia WP for support installation\n' +
  'Huationg\nSoil disposal works on going to Gate #33 (3 loads)\n';
const nb = productivityFromRecords_(spcNoBul, '', '2026-09-25');
assert(nb.mergedActivities.length === 3, 'non-bulleted sub-contractor message -> 3 activities (got ' + nb.mergedActivities.length + ')');
assert(nb.mergedActivities.some(a => /Exposing 150mm dia WP/i.test(a.activity)), 'the SCT "Exposing 150mm dia WP" activity is captured');
assert(nb.mergedActivities.some(a => /Soil disposal works on going to Gate #33/i.test(a.activity)), 'the Huationg soil-disposal activity is captured');
assert(nb.mergedActivities.every(a => a.area === 'Area 1'), 'all classified to Area 1');

console.log('\nHide pure "No activity" rows (build-74; isNoActivityOnly_):');
assert(isNoActivityOnly_('No activity.') && isNoActivityOnly_('-No activity.') && isNoActivityOnly_('NS no activity and site condition normal.'),
  'pure "No activity" status lines are flagged');
assert(isNoActivityOnly_('CH140-CH170 No activity this moment'), 'a location code + "No activity" is flagged');
assert(!isNoActivityOnly_('Receiving and Launching shaft 900mm dia Pipe roofing / No activity.'),
  'a line with real work before "No activity" is KEPT');
assert(!isNoActivityOnly_('No activity at that moment CW Jaw Crusher crushing preparation'),
  'a line with real work after "No activity" is KEPT');
(function () {
  var msg = '[9/25/26, 10:00:00 AM] ~ Eng: Sec-C/ER15\nNo activity.\n';
  assert(productivityFromRecords_(msg, '', '2026-09-25').mergedActivities.length === 0,
    'a pure No-activity message yields no activity rows');
})();

console.log('\nMetadata header + blank lines + SPC area (build-53):');
assert(areaFromSection_('SPC') === 'Area 1', 'SPC -> Area 1');
// Full message: metadata header block, blank lines around the sub-sections, trailing manpower.
const spcFull =
  '[9/25/26, 10:00:00 AM] ~ Eng: SPC / CM / Huationg / SCT\n' +
  'Contractor: Huationg / SCT\nTime: 0830 to 1700 (25/09)\n\n' +
  '-\tRoof Slab (NB-CH4220 to CH4305)\n' +
  'Deck soffit lvl 4.050mSHD Mining Excavation from S02 to S01\nCurrent Excavation depth:4.50m/4.50m\n\n\n' +
  'SCT\n\n\nExposing 150mm dia WP for support installation\n\n\n' +
  'Huationg\n\n\nSoil disposal works on going to Gate #33 (3 loads)\n\n\nManpower - 14\n';
const full = productivityFromRecords_(spcFull, '', '2026-09-25');
assert(full.mergedActivities.some(a => /Exposing 150mm dia WP/i.test(a.activity)),
  'SCT activity captured despite the metadata header + many blank lines');
assert(full.mergedActivities.some(a => /Soil disposal works on going to Gate #33/i.test(a.activity)),
  'Huationg activity captured');
assert(!full.mergedActivities.some(a => /^contractor\b|^time\s*:/i.test(a.activity)),
  'Contractor: / Time: metadata lines are NOT activity rows');
assert(full.mergedActivities.every(a => a.area === 'Area 1'),
  'the SPC message classifies to Area 1 even without a Sec-A prefix (got ' + full.mergedActivities.map(a => a.area).join(',') + ')');

console.log('\nDeterministic activities; AI only enriches resource nodes (build-58):');
// Offline parse is authoritative for the activity rows; the AI result only overlays the
// machine / excavation / RC nodes. The AI's activity granularity is ignored entirely.
const fbAuth = buildProductivityResult_('2026-09-25', [
  { area: 'Area 1', section: 'Sec-A/SPC', elementId: '', activity: 'Roof Slab deck soffit mining excavation', stage: 'Excavation', manpower: 14 },
  { area: 'Area 1', section: 'Sec-A/SPC', elementId: '', activity: 'SCT Exposing 150mm dia WP for support installation', stage: 'Other', manpower: 0 }
], 'fallback');
const aiEnrich = buildProductivityResult_('2026-09-25', [
  { area: 'Area 1', section: 'Sec-A/SPC', elementId: '', activity: 'ROOF SLAB', stage: 'Excavation', manpower: 0 },
  { area: 'Area 1', section: 'Sec-A/SPC', elementId: '', activity: 'DECK SOFFIT', stage: 'Excavation', manpower: 0 },
  { area: 'Area 1', section: 'Sec-A/SPC', elementId: '', activity: 'MINING EXCAVATION', stage: 'Excavation', manpower: 0 }
], 'ai');
aiEnrich.machineStatus = { bcCutters: [{ machineId: 'BC Cutter 1', area: 'Area 1', location: 'SPC', machineState: 'Active', workingOnElements: [], evidence: 'x' }], boringRigs: [] };
const mg = mergeProductivity_(fbAuth, aiEnrich);
assert(mg.mergedActivities.length === 2, 'activities come from the offline parse (2), NOT the AI split (3) (got ' + mg.mergedActivities.length + ')');
assert(mg.mergedActivities.some(a => /Exposing 150mm dia WP/i.test(a.activity)), 'the deterministic SCT activity is present');
assert(!mg.mergedActivities.some(a => a.activity === 'ROOF SLAB'), 'the AI split pieces are NOT used');
assert(mg.machineStatus && mg.machineStatus.bcCutters.length === 1, 'the AI machineStatus IS overlaid');
assert(mg.grandTotals.totalManpower === 14, 'manpower from the offline activities (14)');
// If offline found nothing, fall back to the AI result.
assert(mergeProductivity_(buildProductivityResult_('2026-09-25', [], 'fallback'), aiEnrich) === aiEnrich,
  'empty offline -> use the AI result');

console.log('\nrunComparison end-to-end (offline productivity):');
const rc = runComparison(rto, ais, '2026-08-05');
assert(rc.reportDate === '2026-08-05', 'runComparison reports the date');
assert(Array.isArray(rc.areas) && rc.areas.length === 3, 'runComparison returns area breakdown');
assert(rc.productivityData && rc.productivityData.dWallCount === 2, 'runComparison returns grand productivityData');
assert(Array.isArray(rc.mergedActivities) && rc.mergedActivities.length === 3, 'runComparison returns mergedActivities');
// Regression (build-31): runComparison MUST pass the Resource & Production nodes through,
// or the uploader's Save persists empty machine/excavation/RC data (Viewer showed 0).
assert(rc.machineStatus && rc.machineStatus.bcCutters.length <= 6 && rc.machineStatus.boringRigs.length <= 4,
  'runComparison returns machineStatus (deployed, hard-capped 6/4)');
assert(!!rc.excavation && !!rc.reinforcedConcrete, 'runComparison returns excavation + reinforcedConcrete');

console.log('\nWhatsApp Cloud API webhook ingestion:');
const waPayload = {
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        contacts: [{ wa_id: '60123456789', profile: { name: 'RTO Eng' } },
                   { wa_id: '60198887777', profile: { name: 'AIS Eng' } }],
        messages: [
          { from: '60123456789', id: 'wamid.A', timestamp: '1754380800', type: 'text', text: { body: 'DW1547 casting 42 m3' } },
          { from: '60198887777', id: 'wamid.B', timestamp: '1754380900', type: 'text', text: { body: 'BP-T9-3 boring' } },
          { from: '60123456789', id: 'wamid.C', timestamp: '1754381000', type: 'image', image: { id: 'media1' } }
        ]
      }
    }]
  }]
};
const waMsgs = parseWebhookMessages_(waPayload);
assert(waMsgs.length === 3, 'parseWebhookMessages returns all 3 messages (got ' + waMsgs.length + ')');
assert(waMsgs[0].text === 'DW1547 casting 42 m3' && waMsgs[0].name === 'RTO Eng', 'text message carries body + contact name');
assert(waMsgs[2].type === 'image' && waMsgs[2].text === '', 'non-text message logged with empty text');
assert(parseWebhookMessages_({ object: 'other' }).length === 0, 'non-WABA payload yields no messages');
assert(parseWebhookMessages_({}).length === 0, 'empty payload is safe');

const srcMap = { '60123456789': 'RTO', '60198887777': 'AIS' };
assert(phoneSource_('60198887777', srcMap) === 'AIS', 'phoneSource maps a known AIS phone');
assert(phoneSource_('+60 12-345 6789', srcMap) === 'RTO', 'phoneSource normalises punctuation before matching');
assert(phoneSource_('60111111111', srcMap) === 'RTO', 'phoneSource defaults unknown -> RTO');
assert(normalizePhone_('+60 12-345 6789') === '60123456789', 'normalizePhone strips non-digits');

assert(/^\d{4}-\d{2}-\d{2}$/.test(waTimestampToDate_('1754380800')), 'waTimestampToDate returns yyyy-mm-dd');
assert(waTimestampToDate_('1754380800') === toDateStr_(new Date(1754380800 * 1000)), 'waTimestampToDate matches toDateStr of the instant');
assert(waTimestampToDate_('') === '' && waTimestampToDate_(0) === '', 'waTimestampToDate empty for missing ts');

const dayTexts = buildDayTexts_([
  { waId: 'wamid.A', source: 'RTO', text: 'DW1547 casting 42 m3' },
  { waId: 'wamid.A', source: 'RTO', text: 'DW1547 casting 42 m3' },   // duplicate id -> dropped
  { waId: 'wamid.B', source: 'AIS', text: 'BP-T9-3 boring' },
  { waId: 'wamid.C', source: 'RTO', text: '' },                        // empty -> dropped
  { waId: 'wamid.D', source: 'unknown', text: 'kicker cast' }          // unknown -> RTO
]);
assert(dayTexts.rto === 'DW1547 casting 42 m3\nkicker cast', 'buildDayTexts groups RTO, dedups id, drops empty, folds unknown->RTO');
assert(dayTexts.ais === 'BP-T9-3 boring', 'buildDayTexts groups AIS stream');

console.log('\nResource & Production — machine / excavation / RC:');
// machineTrigger_ — ONLY bite (bc) / depth (rig) attaches an element; rebar cage / casting do NOT.
assert(machineTrigger_('DW1547 1st bite : 21.50m', 'bc') === 'bite', 'bc trigger: bite');
assert(machineTrigger_('DW20 rebar cage lowering', 'bc') === '', 'bc: rebar cage alone -> NOT detected');
assert(machineTrigger_('DW04 concrete casting 42 m3', 'bc') === '', 'bc: casting alone -> NOT detected');
assert(machineTrigger_('DW1547 site cleared', 'bc') === '', 'bc: no work stage -> not detected');
assert(machineTrigger_('BP-T9-3 current depth: 27.5m', 'rig') === 'depth', 'rig trigger: depth');
assert(machineTrigger_('BP-T4-1 rebar cage', 'rig') === '', 'rig: rebar cage alone -> NOT detected');
assert(machineTrigger_('BP-T9-3 drilling in progress', 'rig') === '', 'rig: no depth -> not detected');

// lifecycleStageFor_ maps text -> the 4-stage enum
assert(lifecycleStageFor_('DW1 1st bite 21m') === 'Excavation', 'bite -> Excavation');
assert(lifecycleStageFor_('DW1 rebar cage lowering') === 'Rebar', 'rebar cage -> Rebar');
assert(lifecycleStageFor_('DW1 concrete casting 54 m3') === 'Concreting', 'casting -> Concreting');
assert(lifecycleStageFor_('DW1 concrete casting completed') === 'Completed', 'casting completed -> Completed');

// elementStageForward_ never regresses
assert(elementStageForward_('Concreting', 'Excavation') === 'Concreting', 'forward-only: keeps Concreting over Excavation');
assert(elementStageForward_('Excavation', 'Rebar') === 'Rebar', 'forward-only: advances Excavation -> Rebar');
assert(elementStageForward_('', 'Excavation') === 'Excavation', 'forward-only: empty -> new');
assert(machineStateFor_('BC cutter breakdown') === 'Maintenance' && machineStateFor_('1st bite') === 'Active',
  'machineStateFor_: breakdown -> Maintenance, else Active');

// build-62: Maintenance/Idle trigger words + keeping idle/maintenance machines
assert(machineStateFromEvidence_('hose change', false) === 'Maintenance', 'state: "change" -> Maintenance');
assert(machineStateFromEvidence_('BC cutter wheel maintenance', false) === 'Maintenance', 'state: "maintenance" -> Maintenance');
assert(machineStateFromEvidence_('boring rig moving gate 16', false) === 'Idle', 'state: "moving" + no work -> Idle');
assert(machineStateFromEvidence_('rig on standby', false) === 'Idle', 'state: "standby" -> Idle');
assert(machineStateFromEvidence_('1st bite 12m', true) === 'Active', 'state: has bite work -> Active');
assert(machineStateFromEvidence_('Singtel exchange building', false) === 'Idle', 'state: "exchange" does NOT trigger Maintenance (whole-word change)');
assert(mentionsMachine_('boring rig is shifting from gate 15 to 16', 'rig') === true && mentionsMachine_('x', 'rig') === false, 'mentionsMachine_ rig');
assert(mentionsMachine_('BC cutter wheel maintenance welding', 'bc') === true, 'mentionsMachine_ bc');
// a NAMED machine with no bite/depth -> an idle / maintenance card (not dropped)
var msIdle = normalizeMachineStatus_(null, [
  { area: 'Area 2', section: 'Sec R/OPP LAMH', elementId: '', activity: 'boring rig is shifting from gate 15 to gate 16' },
  { area: 'Area 1', section: 'Sec A/Singtel', elementId: '', activity: 'BC cutter wheel maintenance welding work ongoing' }
]);
var idleRig = msIdle.boringRigs.filter(function (r) { return r.machineState === 'Idle'; });
assert(idleRig.length === 1 && !idleRig[0].workingOnElements.length, 'a "boring rig shifting" line -> one Idle rig card, no element');
var maintBc = msIdle.bcCutters.filter(function (c) { return c.machineState === 'Maintenance'; });
assert(maintBc.length === 1 && !maintBc[0].workingOnElements.length, 'a "BC cutter wheel maintenance" line -> one Maintenance cutter card, no element');
// server still does NOT pad idle slots (padding is Viewer-side): only real machines are returned
var msNone = normalizeMachineStatus_(null, [{ area: 'Area 1', section: 'Sec-A/Ja', elementId: 'DW01', activity: 'DW01 rebar cage' }]);
assert(msNone.bcCutters.length === 0 && msNone.boringRigs.length === 0, 'server returns no machines when nothing drills/idles (no padding server-side)');

// normalizeMachineStatus_ — nested workingOnElements, grouping, fleet padding to 6/4
var mActs = [
  { elementId: 'DW1547', section: 'ER15', area: 'Area 2', activity: 'DW1547 1st bite : 21.50m' },   // Excavation
  { elementId: 'DW04', section: 'ER15', area: 'Area 2', activity: 'DW04 2nd bite; rebar cage lowering' }, // has bite -> grouped, stage Rebar
  { elementId: 'CW99', section: 'Sec-D', area: 'Area 3', activity: 'CW99 site cleared' },            // no stage -> dropped
  { elementId: 'BP-T9-3', section: 'Opp SJII', area: 'Area 3', activity: 'BP-T9-3 current depth: 27.5m' }, // rig Excavation
  { elementId: 'BP-T4-1', section: 'Ja', area: 'Area 1', activity: 'BP-T4-1 drilling in progress' }  // no depth -> dropped
];
var ms = normalizeMachineStatus_(null, mActs);
assert(ms.bcCutters.length === 1 && ms.boringRigs.length === 1, 'only deployed machines shown (1 cutter + 1 rig), no idle padding');
var bc1 = ms.bcCutters[0];
assert(bc1.machineId === 'BC Cutter 1' && bc1.area === 'Area 2' && bc1.location === 'ER15', 'cutter 1 header: id + area + location');
assert(bc1.workingOnElements.length === 2, 'cutter 1 groups DW1547 + DW04 into workingOnElements');
assert(bc1.workingOnElements[0].elementId === 'DW1547' && bc1.workingOnElements[0].lifecycleStage === 'Excavation', 'element 1 stage Excavation');
assert(bc1.workingOnElements[1].elementId === 'DW04' && bc1.workingOnElements[1].lifecycleStage === 'Rebar', 'element 2 stage Rebar');
// depth is parsed from the element's evidence and lives on the element (for the machine card)
assert(bc1.workingOnElements[0].depth === 21.5, 'element 1 depth 21.5 m parsed onto the element');
assert(bc1.workingOnElements[1].depth === null, 'element 2 (rebar cage, no depth) has null depth');
assert(bc1.machineState === 'Active', 'cutter 1 machineState Active');
var rigActive = ms.boringRigs.filter(function (r) { return r.machineState !== 'Idle'; });
assert(rigActive.length === 1 && rigActive[0].workingOnElements[0].elementId === 'BP-T9-3', 'one rig active with BP-T9-3');
assert(rigActive[0].workingOnElements[0].depth === 27.5, 'rig element depth 27.5 m parsed from "current depth: 27.5m"');

// depth advances with the element when it recurs at a deeper stage/reading
var msDepth = normalizeMachineStatus_(null, [
  { elementId: 'DW07', section: 'ER15', area: 'Area 2', activity: 'DW07 1st bite 12.0m' },
  { elementId: 'DW07', section: 'ER15', area: 'Area 2', activity: 'DW07 2nd bite 22.5m' }
]);
var d7 = msDepth.bcCutters[0].workingOnElements[0];
assert(d7.elementId === 'DW07' && d7.depth === 22.5, 'recurring element keeps the latest depth (22.5 m)');

// casting-only line (no bite) must NOT attach a BC Cutter (bite required)
var msCast = normalizeMachineStatus_(null, [{ elementId: 'DW05', section: 'ER10', area: 'Area 1', activity: 'DW05 concrete casting 42 m3' }]);
assert(msCast.bcCutters.length === 0, 'casting-only (no bite) -> no BC Cutter logged');
// a bitten element that also mentions casting still attaches, at the furthest stage
var msBiteCast = normalizeMachineStatus_(null, [{ elementId: 'DW06', section: 'ER10', area: 'Area 1', activity: 'DW06 3rd bite; concrete casting done' }]);
assert(msBiteCast.bcCutters.length === 1 && msBiteCast.bcCutters[0].workingOnElements[0].lifecycleStage === 'Completed', 'bite + casting done -> logged, stage Completed');

// build-67: machineState = the LATEST reading of the day (no sticky maintenance)
var msLatest = normalizeMachineStatus_(null, [
  { elementId: 'DW200', section: 'ER15', area: 'Area 2', activity: 'DW200 1st bite excavation in progress' },        // Active
  { elementId: 'DW200', section: 'ER15', area: 'Area 2', activity: 'DW200 2nd bite; BC cutter wheel maintenance' },  // Maintenance (mid-day)
  { elementId: 'DW200', section: 'ER15', area: 'Area 2', activity: 'DW200 2nd bite excavation work completed' }       // Active (latest)
]);
assert(msLatest.bcCutters[0].machineState === 'Active', 'latest reading wins: morning maintenance + afternoon active -> Active (got ' + msLatest.bcCutters[0].machineState + ')');
var msLatestMaint = normalizeMachineStatus_(null, [
  { elementId: 'DW201', section: 'ER15', area: 'Area 2', activity: 'DW201 1st bite excavation' },                    // Active
  { elementId: 'DW201', section: 'ER15', area: 'Area 2', activity: 'DW201 1st bite; cutter wheel maintenance ongoing' } // Maintenance (latest)
]);
assert(msLatestMaint.bcCutters[0].machineState === 'Maintenance', 'latest reading wins: last reading maintenance -> Maintenance');
// AI entry: its own machineState is respected even if the evidence mentions maintenance
var msAiState = normalizeMachineStatus_({ bcCutters: [{ machineId: 'BC 1', area: 'Area 2', location: 'ER15', machineState: 'Active', workingOnElements: [{ elementId: 'DW202', lifecycleStage: 'Excavation' }], evidence: '1st bite; earlier wheel maintenance' }], boringRigs: [] }, []);
assert(msAiState.bcCutters[0].machineState === 'Active', 'AI machineState Active respected over a maintenance mention in evidence');

console.log('\nMachine element dedup (build-57): U7-3 / BP U7-3 are one pile:');
assert(normElId_('BP U7-3') === normElId_('U7-3') && normElId_('U7-3') === normElId_('U7–3') && normElId_('BP-U7-3') === normElId_('U7-3'),
  'normElId_ canonicalises BP-prefix and dash variants');
assert(normElId_('DW1547') === 'DW1547' && normElId_('BP270') === 'BP270', 'DW ids and bare BP270 (no separator) are kept');
// AI emitted the same pile two ways on two rigs -> must appear ONCE across all rigs.
var msDup = normalizeMachineStatus_({ bcCutters: [], boringRigs: [
  { machineId: 'Boring Rig 1', area: 'Area 3', location: 'SOD', machineState: 'Active',
    workingOnElements: [{ elementId: 'BP U7-3', lifecycleStage: 'Excavation', depth: 27 }], evidence: 'current depth 27m' },
  { machineId: 'Boring Rig 2', area: 'Area 3', location: 'SOD', machineState: 'Active',
    workingOnElements: [{ elementId: 'U7-3', lifecycleStage: 'Excavation', depth: 28 }], evidence: 'current depth 28m' }
] }, []);
var rigEls = msDup.boringRigs.reduce(function (n, r) { return n + r.workingOnElements.length; }, 0);
assert(rigEls === 1, 'the same pile (BP U7-3 / U7-3) appears once across all rigs (got ' + rigEls + ')');
// Same id offered to both a cutter and a rig -> lands on exactly one machine (global dedup).
var msCross = normalizeMachineStatus_({
  bcCutters: [{ machineId: 'BC 1', area: 'Area 3', location: 'SOD', machineState: 'Active', workingOnElements: [{ elementId: 'U7-3', lifecycleStage: 'Excavation' }], evidence: '1st bite 10m' }],
  boringRigs: [{ machineId: 'Rig 1', area: 'Area 3', location: 'SOD', machineState: 'Active', workingOnElements: [{ elementId: 'U7-3', lifecycleStage: 'Excavation' }], evidence: 'current depth 27m' }]
}, []);
var crossEls = msCross.bcCutters.concat(msCross.boringRigs).reduce(function (n, m) { return n + m.workingOnElements.length; }, 0);
assert(crossEls === 1, 'an element offered to a cutter AND a rig lands on exactly one machine (got ' + crossEls + ')');

// GLOBAL dedup: the same element listed on two AI machines lands on ONE machine only
var msDup = normalizeMachineStatus_({ bcCutters: [
  { machineId: 'BC Cutter 1', area: 'Area 2', location: 'ER15', machineState: 'Active',
    workingOnElements: [{ elementId: 'DW04', lifecycleStage: 'Excavation' }], evidence: '1st bite' },
  { machineId: 'BC Cutter 2', area: 'Area 2', location: 'ER16', machineState: 'Active',
    workingOnElements: [{ elementId: 'DW04', lifecycleStage: 'Rebar' }], evidence: 'rebar cage' }
], boringRigs: [] }, []);
(function(){
  var occ = 0; msDup.bcCutters.forEach(function(c){ c.workingOnElements.forEach(function(e){ if(e.elementId==='DW04') occ++; }); });
  assert(occ === 1, 'DW04 appears on exactly one BC Cutter (got ' + occ + ')');
})();
var msDupRig = normalizeMachineStatus_({ boringRigs: [
  { machineId: 'Boring Rig 1', area: 'Area 3', location: 'Opp SJII', machineState: 'Active', workingOnElements: [{ elementId: 'BP-T9-3', lifecycleStage: 'Excavation' }], evidence: 'depth 27m' },
  { machineId: 'Boring Rig 2', area: 'Area 3', location: 'Opp SJII', machineState: 'Active', workingOnElements: [{ elementId: 'BP-T9-3', lifecycleStage: 'Rebar' }], evidence: 'rebar cage' }
], bcCutters: [] }, []);
(function(){
  var occ = 0; msDupRig.boringRigs.forEach(function(c){ c.workingOnElements.forEach(function(e){ if(e.elementId==='BP-T9-3') occ++; }); });
  assert(occ === 1, 'BP-T9-3 appears on exactly one Boring Rig (got ' + occ + ')');
})();

// Area comes from the element's activity even when the machine location is a bare "ER15"
var msArea = normalizeMachineStatus_(
  { bcCutters: [{ machineId: 'BC Cutter 1', area: '', location: 'ER15', machineState: 'Active',
    workingOnElements: [{ elementId: 'DW04', lifecycleStage: 'Excavation' }], evidence: '1st bite' }], boringRigs: [] },
  [{ elementId: 'DW04', section: 'Sec-C/Mb', area: 'Area 2', activity: 'DW04 1st bite' }]);
(function(){
  var c = msArea.bcCutters.filter(function(x){ return x.machineState !== 'Idle'; })[0];
  assert(c && c.area === 'Area 2', 'ER15 machine inherits Area 2 from DW04 activity (got ' + (c && c.area) + ')');
})();

// The deterministic site map beats the AI's guessed area: AI says the machine + activity are
// "Area 1" but the ER15(Le) section is Area 2 -> the card and the activity must be Area 2.
(function(){
  var ms = normalizeMachineStatus_(
    { bcCutters: [{ machineId: 'BC Cutter 1', area: 'Area 1', location: 'ER15', machineState: 'Active',
      workingOnElements: [{ elementId: 'DW09', lifecycleStage: 'Excavation' }], evidence: 'DW09 1st bite 12m' }], boringRigs: [] },
    [{ elementId: 'DW09', section: 'Sec-C/ER15(Le)', area: 'Area 1', activity: 'DW09 1st bite 12m' }]);
  var c = ms.bcCutters.filter(function(x){ return x.machineState !== 'Idle'; })[0];
  assert(c && c.area === 'Area 2', 'ER15(Le) card is Area 2 even when the AI said Area 1 (got ' + (c && c.area) + ')');
})();
// buildProductivityResult_: an activity the AI tagged Area 1 but whose section is ER15(Le)
// -> normalised to Area 2 (site map wins).
(function(){
  var r = buildProductivityResult_('2026-09-22',
    [{ elementId: 'DW09', section: 'Sec-C/ER15(Le)', area: 'Area 1', activity: 'DW09 1st bite 12m', manpower: 5 }], 'test');
  var a2 = r.areas.filter(function(x){ return x.areaName === 'Area 2'; })[0];
  assert(a2 && a2.kpiBreakdown.dWallCount === 1, 'ER15(Le) activity counted under Area 2, not the AI Area 1');
})();

// AREA PURITY: two elements resolving to different Areas must NOT share one card, even when
// the AI put them on the same machine object. Each element goes to a card of its own Area.
var msAreaSplit = normalizeMachineStatus_(
  { bcCutters: [{ machineId: 'BC Cutter 1', area: 'Area 1', location: 'mixed', machineState: 'Active',
      workingOnElements: [{ elementId: 'DW01', lifecycleStage: 'Excavation' },
                          { elementId: 'DW02', lifecycleStage: 'Excavation' }], evidence: 'bite' }], boringRigs: [] },
  [{ elementId: 'DW01', section: 'Sec-A/Ka', area: 'Area 1', activity: 'DW01 1st bite 10m' },
   { elementId: 'DW02', section: 'Sec-C/Mb', area: 'Area 2', activity: 'DW02 1st bite 12m' }]);
(function(){
  function cardOf(id){ return msAreaSplit.bcCutters.filter(function(c){
    return c.workingOnElements.some(function(e){ return e.elementId==='DW01'||e.elementId==='DW02'; }) &&
           c.workingOnElements.some(function(e){ return e.elementId===id; }); })[0]; }
  var c1 = cardOf('DW01'), c2 = cardOf('DW02');
  assert(c1 && c1.area === 'Area 1', 'DW01 lands on an Area 1 card (got ' + (c1&&c1.area) + ')');
  assert(c2 && c2.area === 'Area 2', 'DW02 lands on an Area 2 card (got ' + (c2&&c2.area) + ')');
  assert(c1 !== c2, 'Area 1 and Area 2 elements are on DIFFERENT cards (never mixed)');
  // no single card holds both areas' elements
  var mixed = msAreaSplit.bcCutters.filter(function(c){
    var ids = c.workingOnElements.map(function(e){return e.elementId;});
    return ids.indexOf('DW01')>=0 && ids.indexOf('DW02')>=0; });
  assert(mixed.length === 0, 'no card mixes DW01 (Area 1) and DW02 (Area 2)');
  assert(msAreaSplit.bcCutters.length === 2, 'only the 2 deployed BC cutters shown (one per Area)');
})();

// Per-element location: two elements at DIFFERENT locations in the SAME area may share a folded
// card, but each element keeps its own location.
(function(){
  var acts=[]; for (var i=1;i<=8;i++) acts.push({ elementId:'DW'+(200+i), section:'Sec-C/loc'+i, area:'Area 2', activity:'DW'+(200+i)+' 1st bite '+(10+i)+'m' });
  var ms8 = normalizeMachineStatus_(null, acts);
  ms8.bcCutters.forEach(function(c){ if(c.workingOnElements.length) assert(c.area==='Area 2', 'all folded cards stay Area 2'); });
  assert(ms8.bcCutters.length === 6, '8 Area-2 locations fold within the area to exactly 6 cutters (got ' + ms8.bcCutters.length + ')');
  var totalEls = ms8.bcCutters.reduce(function(n,c){return n+c.workingOnElements.length;},0);
  assert(totalEls === 8, 'all 8 elements retained across the folded cards (got ' + totalEls + ')');
  var withLoc = ms8.bcCutters.reduce(function(n,c){ return n + c.workingOnElements.filter(function(e){return /^Sec-C\/loc\d+$/.test(e.location||'');}).length; },0);
  assert(withLoc === 8, 'each element keeps its own location (got ' + withLoc + ')');
})();

// maintenance keyword on a grouped machine -> machineState Maintenance
var msMix = normalizeMachineStatus_(null, [
  { elementId: 'DW7', section: 'ER15', area: 'Area 2', activity: 'DW7 1st bite 10m' },
  { elementId: 'DW8', section: 'ER15', area: 'Area 2', activity: 'DW8 2nd bite; rebar cage; BC cutter breakdown' }
]);
assert(msMix.bcCutters[0].machineState === 'Maintenance' && msMix.bcCutters[0].workingOnElements.length === 2,
  'grouped machine -> Maintenance state + both elements');

// AI nested entries kept; legacy assignedIds[] still read into workingOnElements
var msAi = normalizeMachineStatus_({ bcCutters: [
  { machineId: 'BC Cutter A', area: 'Area 2', location: 'ER15', machineState: 'Active',
    workingOnElements: [{ elementId: 'DW1547', lifecycleStage: 'Excavation' }, { elementId: 'DW1548', lifecycleStage: 'Rebar' }], evidence: '2nd bite 30m' },
  { area: 'Area 1', location: 'ZZ', assignedIds: ['DW999'], status: 'Active', evidence: 'DW999 1st bite 5m' }  // legacy shape
], boringRigs: [] }, []);
var aiActive = msAi.bcCutters.filter(function (c) { return c.machineState !== 'Idle'; });
assert(aiActive.length === 2, 'AI nested + legacy machines both kept');
assert(aiActive[0].machineId === 'BC Cutter A' && aiActive[0].workingOnElements.length === 2, 'AI machineId + nested elements kept');
assert(aiActive[1].workingOnElements[0].elementId === 'DW999', 'legacy assignedIds folded into workingOnElements');

// overflow: >6 cutter groups fold into the 6 machines (no data lost, still 6 cards)
var manyDW = []; for (var i = 0; i < 10; i++) manyDW.push({ elementId: 'DW' + i, section: 'L' + i, area: 'Area ' + ((i % 4) + 1), activity: 'DW' + i + ' 1st bite 10m' });
var msCap = normalizeMachineStatus_(null, manyDW);
assert(msCap.bcCutters.length === 6, 'still exactly 6 BC Cutters after overflow');
var totalEls = msCap.bcCutters.reduce(function (n, c) { return n + c.workingOnElements.length; }, 0);
assert(totalEls === 10, 'all 10 elements retained across the 6 machines (got ' + totalEls + ')');

// depth / loads parsing
assert(parseDepthM_('1st bite excavation reaching 24.2 m') === 24.2, 'parseDepthM 24.2 m');
assert(parseDepthM_('BP casting 84 m3') === null, 'parseDepthM ignores m3');
// build-66: never read the panel SIZE "(3.3 x 1.0m)" or "Dia:" as depth; read the current bite depth; take the deepest
assert(parseDepthM_('DW107 (3.3 x 1.0m) / SP GWT +3.587mSHD 1st bite 26.5/29.547m 2nd bite 27.7/29.547m') === 27.7,
  'parseDepthM reads the deepest current bite (27.7), not the panel size 1.0m');
assert(parseDepthM_('(3.3 x 1.0m) / SP') === null, 'parseDepthM: a panel size alone is not a depth');
assert(parseDepthM_('Exposing 150mm dia WP for support') === null, 'parseDepthM ignores "150mm dia"');
assert(parseDepthM_('GIII confirmed at depth 27.5m') === 27.5, 'parseDepthM reads "depth 27.5m"');
assert(parseLoads_('soil disposal 14 loads today') === 14, 'parseLoads 14 loads');

// build-68: combine same-work photo/progress repeats; manpower max (not summed); MP-8; TTMT area
assert(firstManpower_('MP - 8') === 8 && firstManpower_('MP:8') === 8, 'firstManpower_ reads "MP - 8"/"MP:8"');
assert(groutingArea_('TTMT CM') === 'Area 1' && groutingArea_('TTMT CM Ma2a') === 'Area 1', 'groutingArea_ TTMT -> Area 1');
(function () {
  // 8 progress messages of the SAME element (DW300) + one DISTINCT work in the same location
  var acts = [];
  ['SET extraction', '1st bite 10m', 'cutter wheel maintenance', '2nd bite chiseling',
   'resume excavation', '2nd bite 22m', 'chiseling', '2nd bite excavation work completed'].forEach(function (w, i) {
    acts.push({ area: 'Area 2', section: 'Sec-C/ER15', elementId: 'DW300', activity: 'DW300 ' + w, stage: 'Excavation', manpower: i === 1 ? 6 : 0 });
  });
  acts.push({ area: 'Area 2', section: 'Sec-C/ER15', elementId: '', activity: 'Micro pile head hack and clean', stage: 'Other', manpower: 4 });
  var m = mergeSameWork_(acts);
  var dw = m.filter(function (a) { return normElId_(a.elementId) === 'DW300'; });
  assert(dw.length === 1, 'the 8 DW300 progress messages merge into ONE row (got ' + dw.length + ')');
  assert(dw[0].manpower === 6, 'merged manpower is the MAX across the cluster (6), not summed');
  assert(m.length === 2, 'a distinct element-less work at the same location stays separate (2 rows total)');
})();

console.log('\nOne row per location (build-70; collapseByLocation_):');
(function () {
  // Two distinct works at the SAME location (Sec-C/ER15) + one at a DIFFERENT location (Sec-C/Qd).
  var acts = [
    { area: 'Area 2', section: 'Sec-C/ER15', elementId: 'DW300', activity: 'DW300 2nd bite excavation 22m', stage: 'Excavation', manpower: 6 },
    { area: 'Area 2', section: 'Sec-C/ER15', elementId: 'DW301', activity: 'DW301 rebar cage lowering', stage: 'Rebar', manpower: 4 },
    { area: 'Area 2', section: 'Sec-C/Qd', elementId: '', activity: 'Kingpost drilling in progress', stage: 'Other', manpower: 3 }
  ];
  var c = collapseByLocation_(acts);
  assert(c.length === 2, 'two works at one location + one elsewhere -> 2 location rows (got ' + c.length + ')');
  var er = c.find(function (a) { return a.section === 'Sec-C/ER15'; });
  assert(/DW300/.test(er.activity) && /DW301/.test(er.activity), 'the ER15 row keeps BOTH works\' text (nothing dropped)');
  assert(er.manpower === 10, 'location manpower is the SUM of its works (6+4=10, not max)');
  assert(er.stage === 'Rebar', 'location stage is the furthest reached (Rebar)');
  // KPI element counts are preserved because they are scanned from the combined text.
  var built = buildProductivityResult_('2026-10-06', collapseByLocation_(acts), 'fallback');
  assert(built.productivityData.dWallCount === 2, 'both DW300 & DW301 still counted after collapse (got ' + built.productivityData.dWallCount + ')');
})();
(function () {
  // Config toggle: 'work' granularity skips the collapse (per-work rows).
  var msg =
    '[10/6/26, 9:00:00 AM] ~ Eng: Sec-C/ER15\nDW300 excavation 22m\nManpower: 6\n' +
    '[10/6/26, 9:05:00 AM] ~ Eng: Sec-C/ER15\nDW301 rebar cage lowering\nManpower: 4\n';
  sandbox.PARSER_CONFIG.activityGranularity = 'location';
  var loc = productivityFromRecords_(msg, '', '2026-10-06');
  assert(loc.mergedActivities.length === 1, 'granularity=location -> the two ER15 messages collapse to 1 row (got ' + loc.mergedActivities.length + ')');
  sandbox.PARSER_CONFIG.activityGranularity = 'work';
  var wrk = productivityFromRecords_(msg, '', '2026-10-06');
  assert(wrk.mergedActivities.length === 2, 'granularity=work -> the two ER15 messages stay 2 rows (got ' + wrk.mergedActivities.length + ')');
})();

console.log('\nArea<->Segment pairing in the section label (build-73):');
// New map entries: Dyson / Boseng -> Area 4; TMC / TTMT -> Area 1.
assert(areaFromSection_('Sec-E/Dyson') === 'Area 4' && areaFromSection_('Dyson') === 'Area 4', 'Dyson -> Area 4');
assert(areaFromSection_('Boseng') === 'Area 4', 'Boseng -> Area 4');
assert(areaFromSection_('Sec A/TMC Car Park') === 'Area 1' && areaFromSection_('TMC') === 'Area 1', 'TMC -> Area 1 (was mis-filed to Area 4)');
assert(areaFromSection_('TTMT') === 'Area 1', 'TTMT -> Area 1');
// segmentsOnLine_ lists every recognised zone segment on a header (primary first), skips 1-char (N/P/R).
(function () {
  var segs = segmentsOnLine_('Sec E/XR14/Whitley RD/Dyson Island Lb1,Lb2,Lb3,Boseng Ave,Whitley Villas &CJC');
  assert(segs.indexOf('XR14') === 0, 'primary segment (XR14) is first');
  ['Dyson', 'Lb1', 'Lb2', 'Lb3', 'Boseng'].forEach(function (s) {
    assert(segs.indexOf(s) >= 0, 'segmentsOnLine_ captures ' + s);
  });
})();
// displaySection_ pairs the base section with the extra segments (base segment not repeated).
assert(displaySection_({ section: 'Sec-E/XR14', segments: ['XR14', 'Dyson', 'Lb1', 'Lb2', 'Lb3', 'Boseng'] })
  === 'Sec-E/XR14 · Dyson, Lb1, Lb2, Lb3, Boseng', 'section paired with the finer segments');
assert(displaySection_({ section: 'Sec-A/Ja', segments: ['Ja'] }) === 'Sec-A/Ja', 'no extras -> section unchanged');
assert(displaySection_({ section: 'Sec-D', segments: [] }) === 'Sec-D', 'no segments -> section unchanged');
// end-to-end: the finer segments from the header are shown; area stays Area 4.
(function () {
  var msg = '[10/6/26, 9:00:00 AM] ~ Eng: Sec E/XR14/Whitley RD/Dyson Island Lb1,Lb2,Lb3,Boseng Ave\nHoarding installation works ongoing\n';
  var r = productivityFromRecords_(msg, '', '2026-10-06');
  var row = r.mergedActivities[0];
  assert(/Sec-E\/XR14 ·/.test(row.section) && /Dyson/.test(row.section) && /Lb1/.test(row.section) && /Boseng/.test(row.section),
    'displayed section pairs XR14 with Dyson/Lb1/Boseng (got "' + row.section + '")');
  assert(row.area === 'Area 4', 'area stays Area 4 (the pairing does not disturb area resolution)');
})();

// excavation normaliser
var ex = normalizeExcavation_({ totalVolumeOrLoads: 14, activeExcavations: [
  { location: 'CW323', currentDepth: 24.2, activity: '1st bite excavation ongoing' }] }, []);
assert(ex.totalVolumeOrLoads === 14 && ex.activeExcavations.length === 1, 'excavation keeps AI zones + loads');
assert(ex.activeExcavations[0].currentDepth === 24.2, 'excavation depth coerced to number');
var exFallback = normalizeExcavation_(null, [{ elementId: 'CW323', stage: 'Excavation', activity: 'excavation to 12 m' }]);
assert(exFallback.activeExcavations.length === 1 && exFallback.activeExcavations[0].currentDepth === 12,
  'excavation derived from Excavation-stage activity + depth parsed');

// RC classifier + normaliser
assert(classifyRcType_('rebar fixing') === 'Rebar', 'classifyRcType rebar -> Rebar');
assert(classifyRcType_('formwork installation') === 'Formwork', 'classifyRcType formwork -> Formwork');
assert(classifyRcType_('concrete casting 84 m3') === 'Concreting', 'classifyRcType casting -> Concreting');
var rcNode = normalizeRC_({ totalConcreteVolumeM3: 84, rcActivities: [
  { location: 'BP Qd4-2', type: 'Concreting', activity: 'Casting preparation works, 84m3' }] }, [], 0);
assert(rcNode.totalConcreteVolumeM3 === 84 && rcNode.rcActivities.length === 1, 'RC keeps AI total + activities');
var rcFallback = normalizeRC_(null, [{ elementId: 'DW04', activity: 'concrete casting 42 m3' }], 42);
assert(rcFallback.totalConcreteVolumeM3 === 42 && rcFallback.rcActivities[0].type === 'Concreting',
  'RC falls back to grand concrete + derives Concreting activity');

// end-to-end: normalizeProductivity_ (AI shape) carries the three nodes
var rawAi = {
  date: '2026-08-05',
  areas: [{ areaName: 'Area 2', kpiBreakdown: {}, activities: [
    { elementId: 'DW1547', section: 'Sec-C/Mb', activityDescription: 'DW1547 concrete casting 54/54 m3', stage: 'Concrete Casting', manpower: 8 }] }],
  grandTotals: { totalConcreteVolumeM3: 54, totalManpower: 8 },
  machineStatus: { bcCutters: [{ machineId: 'BC Cutter 1', area: 'Area 2', location: 'ER15', machineState: 'Active',
    workingOnElements: [{ elementId: 'DW1547', lifecycleStage: 'Excavation' }], evidence: 'DW1547 1st bite : 21.50m' }], boringRigs: [] },
  excavation: { totalVolumeOrLoads: 0, activeExcavations: [] },
  reinforcedConcrete: { totalConcreteVolumeM3: 54, rcActivities: [{ location: 'DW1547', type: 'Concreting', activity: 'casting 54 m3' }] }
};
var np = normalizeProductivity_(rawAi, '2026-08-05', 'ai');
var npBc = np.machineStatus.bcCutters.filter(function (c) { return c.machineState !== 'Idle'; })[0];
assert(npBc && npBc.workingOnElements[0].elementId === 'DW1547', 'normalizeProductivity_ overlays AI machineStatus (nested element)');
assert(npBc.location === 'ER15' && npBc.area === 'Area 2', 'AI machine location kept + area from element activity (Area 2)');
assert(np.machineStatus.bcCutters.length === 1, 'AI path shows only the 1 deployed cutter (no padding)');
assert(np.reinforcedConcrete.totalConcreteVolumeM3 === 54, 'normalizeProductivity_ carries RC total');

// offline fallback also produces the nested machine nodes
var fbRes = productivityFromRecords_(
  '[5/8/26, 10:00:00] ~ Eng: Sec-C/Mb\nDW04 1st bite 20m, concrete casting 42 m3\nManpower: 8\n', '', '2026-08-05');
var fbBc = fbRes.machineStatus.bcCutters.filter(function (c) { return c.machineState !== 'Idle'; });
assert(fbBc.length >= 1 && fbBc[0].workingOnElements.length >= 1, 'fallback detects a BC Cutter with a nested element');
assert(fbRes.reinforcedConcrete.totalConcreteVolumeM3 === 42, 'fallback RC total = concrete cast (42)');

console.log('\n' + (failures ? (failures + ' FAILED') : 'ALL PASSED'));
process.exit(failures ? 1 : 0);
