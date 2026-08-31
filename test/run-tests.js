/**
 * Node harness for the .gs logic. Apps Script runs every .gs file in one shared
 * global scope; to mirror that faithfully (Extract.gs calls Parser.gs globals),
 * we load Parser/Compare/Extract into a single VM sandbox and call functions off
 * it — rather than requiring each file as an isolated CommonJS module.
 * Run: `node test/run-tests.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = {};
vm.createContext(sandbox);
['Parser.gs', 'Compare.gs', 'Extract.gs'].forEach((f) => {
  // No `module` in the sandbox, so each file's `typeof module` export guard is
  // skipped and its functions land as sandbox globals — exactly like GAS.
  vm.runInContext(fs.readFileSync(path.join(root, 'gas', f), 'utf8'), sandbox, { filename: f });
});
const { parseWhatsApp, resolveLocator_, normalizeDate_, normalizeExtracted_, compareRecords,
        normalizeSummary_, summaryFromRecords_ } = sandbox;

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
assert(sam.length === 3, 'Samsung parses 3 records (Mb, Ub, Ua); chatter/RFI/emoji dropped — got ' + sam.length);
assert(rto.concat(sam).every(r => r.area !== 'General'),
  'requireLocator drops no-locator junk (nothing lands in General)');

const mb = rto.find(r => r.area === 'Sec-C/Mb');
assert(!!mb, 'RTO Mb record built');
assert(mb && mb.photos === 3, 'RTO Mb folds inline + 2 standalone photos = 3 (got ' + (mb && mb.photos) + ')');
const ub = rto.find(r => r.area === 'Sec-D/Ub');
assert(ub && /manpower/i.test(ub.remark), 'RTO Ub manpower line captured in remark');
assert(rto.every(r => r.date === '2026-08-05'), 'all RTO dates -> 2026-08-05');

console.log('\nArea group mapping:');
assert(mb && mb.areaGroup === 'Area 2', 'Sec-C/Mb -> Area 2');
assert(ub && ub.areaGroup === 'Area 3', 'Sec-D/Ub -> Area 3');

console.log('\nAI extraction normaliser (same shape as the parser):');
const ai = normalizeExtracted_(
  { date: '5/8/26', section: 'Sec-C', segment: 'Mb', activity: 'Dwall reinstatement, DW64 curing', remark: 'Manpower 7pax', photos: 3 },
  'RTO');
assert(ai.area === 'Sec-C/Mb' && ai.areaGroup === 'Area 2', 'AI record -> Sec-C/Mb + Area 2');
assert(ai.date === '2026-08-05', 'AI record date normalised to ISO');
assert(['source','date','area','areaGroup','section','segment','activity','remark','photos']
  .every(k => k in ai), 'AI record carries the canonical fields');
assert(normalizeExtracted_({ activity: '' }, 'RTO') === null, 'AI record with empty activity dropped');

console.log('\nWork summary — AI output normaliser:');
const aiSummary = normalizeSummary_({
  date: '5/8/26',
  executiveSummary: ['Slip Road Tunnel dwall works progressing', 'Base Slab curing at Sec-D/Ub', 'One quantity discrepancy flagged', 'x','x','x','x'],
  sectionBreakdown: [{ area: 'Area 2', section: 'Sec-C/Mb', work: 'Dwall reinstatement' }, { area:'', section:'', work:'' }],
  rtoVsAisDiscrepancies: [{ item: 'Sec-D/Ub', rto: '7 pax', ais: '9 pax', severity: 'Medium' }],
  manpowerAndRemarks: ['Kian Hup 7 pax', '']
}, 'ai');
assert(aiSummary.status === 'Discrepancy', 'summary with a discrepancy -> status Discrepancy');
assert(aiSummary.date === '2026-08-05', 'summary date normalised to ISO');
assert(aiSummary.executiveSummary.length === 6, 'executiveSummary capped at 6 (got ' + aiSummary.executiveSummary.length + ')');
assert(aiSummary.sectionBreakdown.length === 1, 'empty sectionBreakdown entries dropped');
assert(aiSummary.discrepancies[0].severity === 'medium', 'severity lower-cased');
assert(['date','status','executiveSummary','sectionBreakdown','discrepancies','manpowerAndRemarks','source']
  .every(k => k in aiSummary), 'summary carries the canonical fields');
const aligned = normalizeSummary_({ date: '2026-08-05', executiveSummary: ['all good'], rtoVsAisDiscrepancies: [] }, 'ai');
assert(aligned.status === 'Aligned', 'no discrepancies -> status Aligned');

console.log('\nWork summary — deterministic fallback (no AI):');
const fb = summaryFromRecords_(
  fs.readFileSync(path.join(root, 'samples', 'rto.sample.txt'), 'utf8'),
  fs.readFileSync(path.join(root, 'samples', 'samsung.sample.txt'), 'utf8'));
assert(fb.source === 'fallback', 'fallback marked source=fallback');
assert(fb.date === '2026-08-05', 'fallback picks the reporting date');
assert(fb.executiveSummary.length >= 3, 'fallback produces 3+ exec bullets');
assert(fb.status === 'Discrepancy', 'fallback flags Discrepancy (Ub conflict + missing)');
assert(fb.discrepancies.length === 3, 'fallback lists 3 discrepancies (1 conflict + 2 missing)');
assert(fb.sectionBreakdown.length === 4, 'fallback section breakdown covers all 4 keys');

console.log('\nComparison:');
const cmp = compareRecords(rto, sam);
const byKey = {};
cmp.rows.forEach(r => { byKey[r.area] = r; });
assert(byKey['Sec-C/Mb'].status === 'Match', 'Sec-C/Mb (differently worded) -> Match');
assert(byKey['Sec-D/Ub'].status === 'Conflict', 'Sec-D/Ub (7pax vs 9pax) -> Conflict');
assert(byKey['Sec-C/Ld'].status === 'MissingSamsung', 'Sec-C/Ld -> MissingSamsung');
assert(byKey['Sec-D/Ua'].status === 'MissingRTO', 'Sec-D/Ua -> MissingRTO');

console.log('\nSummary:');
assert(cmp.overall.total === 4, 'overall 4 distinct keys');
assert(cmp.overall.matched === 1, 'overall matched = 1');
assert(cmp.overall.accuracyPct === 25, 'overall accuracy 25% (got ' + cmp.overall.accuracyPct + ')');

console.log('\n' + (failures ? (failures + ' FAILED') : 'ALL PASSED'));
process.exit(failures ? 1 : 0);
