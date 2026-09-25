/**
 * Code.gs — Apps Script web app server for the N106 WhatsApp accuracy tool.
 *
 * Responsibilities:
 *   doGet()          -> serve the upload/edit/compare UI
 *   runComparison()  -> parse + compare two pasted exports (called from client)
 *   saveToSheet()    -> write Records / Comparison / DailySummary tabs
 *
 * Parsing/comparison logic lives in Parser.gs and Compare.gs.
 */

// Target spreadsheet ID (the part of the Sheet URL between /d/ and /edit).
// MUST be set for the web app: in a web-app context getActiveSpreadsheet() is
// unreliable, so pin the ID here. This is the "N106 Summary AI" sheet; change it
// if you switch spreadsheets. Leaving it '' falls back to the active sheet
// (works only in the bound editor, NOT reliably in the deployed Viewer).
var SPREADSHEET_ID = '1aXeTe2j7vdLI3nXk2duBlou00mOu03M8aSN32e21Jj8';

var TABS = {
  activities: 'Activities',      // one row per merged activity (per date)
  productivity: 'Productivity',  // one row per date: DW/BP/BT/CW counts, concrete m3, manpower
  raw: 'Raw_Logs',               // append-only audit of inbound WhatsApp Cloud API messages
  summaries: 'DailySummaries',   // one row per date: Resource & Production nodes (JSON) + flat totals
  machineLogs: 'DailyMachineLogs', // one row per machine per date: machineId/area/location/state/elements
  elementTracker: 'ElementTracker', // persistent, one row per element: forward-only lifecycle stage
  excavationProgress: 'ExcavationProgress' // static soil-volume tracker (Tunnel/FB): planned vs cumulative m3
  , excavationDaily: 'ExcavationDaily' // user-maintained daily soil log: date/zone/m3 (rolled up D/W/M in the Viewer)
};

// Static soil-volume tracker — mirrors the user's Excavation Tracker spreadsheet. The user
// maintains planned_m3 / cumulative_m3 here (or pastes from their sheet); the Viewer computes
// Remaining + % Progress. Seeded from N106_Excavation_Tracker.xlsx (Progress tab) on first run.
var EXCAV_PROGRESS_HEADER = ['zone', 'category', 'description', 'planned_m3', 'cumulative_m3', 'updated'];
var EXCAV_PROGRESS_SEED = [
  ['Tunnel', 'Tunnel', 'Area 2', 1178552, 53722, ''],
  ['FB', 'FB', 'Area 4 - FB', 171749, 20882, '']
];

// Daily soil-disposal log — one row per date+zone in m3. The user fills this (or pastes from
// their spreadsheet's Daily_Log); the Viewer rolls it up Daily / Weekly / Monthly and falls
// back to the reported loads x factor for any day with no rows here.
var EXCAV_DAILY_HEADER = ['date', 'zone', 'm3', 'note'];

/**
 * DIAGNOSTIC — run this from the Apps Script editor (select debugSheet -> Run),
 * then open View -> Logs (or Executions). No deployment needed. It prints which
 * spreadsheet getSpreadsheet_() actually opens and every tab's row count, so a
 * wrong-sheet / wrong-tab-name mismatch is obvious.
 */
function debugSheet() {
  var ss = getSpreadsheet_();
  Logger.log('SPREADSHEET_ID setting = "' + SPREADSHEET_ID + '"');
  Logger.log('Opened spreadsheet: "' + ss.getName() + '"');
  Logger.log('URL: ' + ss.getUrl());
  Logger.log('--- all tabs in this spreadsheet ---');
  ss.getSheets().forEach(function (s) {
    Logger.log('tab "' + s.getName() + '"  lastRow=' + s.getLastRow());
  });
}

/**
 * DIAGNOSTIC — runs the EXACT function the Viewer calls (getReport) from the
 * editor. If this logs comparison rows > 0 but the deployed Viewer still shows
 * 0, the deployment is stale (redeploy a New version). If this logs 0, getReport
 * itself is the problem.
 */
function debugGetReport() {
  var r = getReport();
  Logger.log('getReport spreadsheet: "' + r.spreadsheetName + '"');
  Logger.log('activities rows: ' + r.activities.length);
  if (r.activities[0]) Logger.log('first activity: ' + JSON.stringify(r.activities[0]));
  Logger.log('productivity days: ' + r.productivity.length);
  if (r.productivity[0]) Logger.log('latest productivity: ' + JSON.stringify(r.productivity[r.productivity.length - 1]));
  // Machine data check — shows, per DailySummaries date, how many machines are saved and
  // how many are actually deployed (have elements). If "deployed" is 0 for a day you know
  // had machines in Compare, that day was NOT re-Saved on this Sheet after the fix.
  var sums = r.summaries || [];
  Logger.log('DailySummaries days: ' + sums.length);
  sums.forEach(function (s) {
    var ms = s.machineStatus || { bcCutters: [], boringRigs: [] };
    var all = (ms.bcCutters || []).concat(ms.boringRigs || []);
    var deployed = all.filter(function (m) {
      return m && ((m.workingOnElements && m.workingOnElements.length) ||
        String(m.machineState || m.status || '').toLowerCase() !== 'idle');
    }).length;
    Logger.log('  ' + s.date + ' — machines saved: ' + all.length + ', deployed: ' + deployed);
  });
}

// Bump this on every deploy so the running version is visible in the browser —
// if the Viewer doesn't show this string, the deployed code is stale/wrong.
var APP_VERSION = 'build-44 · DW/BP/BT/CW KPIs back on ERSS';

/**
 * Route:
 *   ?page=view  -> Viewer.html   (directors: interactive, editable report)
 *   (default)   -> Index.html    (you: upload / compare / save)
 *
 * For the viewer, the report data is read server-side and injected straight into
 * the page (window.__REPORT__), so it no longer depends on a client-side
 * google.script.run round-trip.
 */
function doGet(e) {
  // WhatsApp Cloud API webhook verification (Meta GETs the URL with hub.* params).
  // Handled first so it never falls through to HTML routing. Returns null otherwise.
  var hub = handleWebhookGet_(e);
  if (hub) return hub;

  var page = (e && e.parameter && e.parameter.page) || '';
  var file = page === 'view' ? 'Viewer' : 'Index';
  var title = page === 'view'
    ? 'N106 — Site Record Report'
    : 'N106 — WhatsApp Site Record Accuracy';
  var t = HtmlService.createTemplateFromFile(file);
  t.appVersion = APP_VERSION;
  if (page === 'view') {
    var rep;
    try { rep = getReport(); } catch (err) { rep = { error: String(err) }; }
    // Escape "<" so a stray "</script>" in the data can't break the page.
    t.reportJson = JSON.stringify(rep).replace(/</g, '\\u003c');
  } else {
    t.reportJson = 'null';
  }
  return t.evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Let a template pull in its partial .html files (styles/scripts). */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Analyse the two pasted reports -> merged activities + productivity metrics.
 * Uses AI (Extract.gs) when an API key is set, else a deterministic fallback.
 * Nothing is persisted here; the client re-sends the result to saveToSheet.
 */
function runComparison(rtoText, aisText, reportDate) {
  // Scope a full-history RTO chat to the report date so only that day is used.
  var target = reportDate ? normalizeDate_(reportDate) : '';
  var rtoScoped = target ? sliceChatByDate_(rtoText, [target]) : rtoText;
  var prod = generateProductivity(rtoScoped, aisText, target);
  return {
    date: prod.date,
    reportDate: target || prod.date || '',
    usedAi: !!getApiKey_(),
    source: prod.source,
    areas: prod.areas,
    grandTotals: prod.grandTotals,
    mergedActivities: prod.mergedActivities,
    productivityData: prod.productivityData,
    // Resource & Production nodes — MUST be passed through so the uploader's Save
    // (saveToSheet(lastResult)) persists them. Omitting these made machines/excavation/RC
    // save as empty (Viewer showed 0).
    machineStatus: prod.machineStatus,
    excavation: prod.excavation,
    reinforcedConcrete: prod.reinforcedConcrete
  };
}

var ACTIVITY_HEADER = ['date', 'area', 'section', 'element_id', 'activity', 'manpower', 'stage'];
var PRODUCTIVITY_HEADER = ['date', 'dwall_count', 'bpile_count', 'bwall_count', 'cwall_count',
  'concrete_m3', 'total_manpower', 'active_dwalls', 'active_bpiles', 'active_bwalls', 'active_crosswalls'];
// Resource & Production view: the three pillar nodes stringified per date, plus a few
// flat convenience numbers. This is a NEW tab — existing tabs/rows are untouched.
var SUMMARY_HEADER = ['date', 'total_concrete_m3', 'total_loads', 'active_cutters', 'active_rigs',
  'machine_status_json', 'excavation_json', 'rc_json'];
// Unified machine + element-lifecycle tabs (FOLLOW-UP 16).
var MACHINE_LOG_HEADER = ['date', 'machine_id', 'family', 'area', 'location', 'machine_state', 'elements', 'evidence'];
var ELEMENT_TRACKER_HEADER = ['element_id', 'type', 'area', 'location', 'lifecycle_stage', 'last_machine', 'first_seen', 'last_updated'];

/**
 * Persist the productivity result. `result` is what runComparison returned.
 * Upserts by date so history accumulates for the charts. Returns the sheet URL.
 */
function saveToSheet(result) {
  var ss = getSpreadsheet_();
  var date = result.date || result.reportDate || '';
  ensureExcavationProgress_(ss);   // make sure the static soil-volume tracker tab exists
  ensureExcavationDaily_(ss);      // and the daily soil-log tab

  // Activities: one row per merged activity (all rows for this date replaced).
  upsertByDate_(ss, TABS.activities, ACTIVITY_HEADER, 0,
    (result.mergedActivities || []).map(function (a) {
      return [date, a.area || '', a.section || '', a.elementId || '', a.activity || '',
        a.manpower || 0, a.stage || ''];
    }));

  // Productivity: one row per date (metrics for the charts).
  var p = result.productivityData || {};
  upsertByDate_(ss, TABS.productivity, PRODUCTIVITY_HEADER, 0, [[
    date, p.dWallCount || 0, p.bPileCount || 0, p.bWallCount || 0, p.cWallCount || 0,
    p.totalConcreteVolumeM3 || 0, p.totalManpower || 0,
    (p.activeDWalls || []).join(', '), (p.activeBoredPiles || []).join(', '),
    (p.activeButtressWalls || []).join(', '), (p.activeCrossWalls || []).join(', ')
  ]]);

  // DailySummaries: the Resource & Production nodes for this date (Machine / Excavation /
  // RC), stringified + a few flat convenience numbers. New tab — never breaks other rows.
  var machine = result.machineStatus || { bcCutters: [], boringRigs: [] };
  var excav = result.excavation || { totalVolumeOrLoads: 0, activeExcavations: [] };
  var rc = result.reinforcedConcrete || { totalConcreteVolumeM3: 0, rcActivities: [] };
  upsertByDate_(ss, TABS.summaries, SUMMARY_HEADER, 0, [[
    date,
    rc.totalConcreteVolumeM3 || p.totalConcreteVolumeM3 || 0,
    excav.totalVolumeOrLoads || 0,
    countActive_(machine.bcCutters), countActive_(machine.boringRigs),
    JSON.stringify(machine), JSON.stringify(excav), JSON.stringify(rc)
  ]]);

  // Unified 2-in-1 machine + element-lifecycle write. ONE loop over every machine:
  //   Action A -> a DailyMachineLogs row (this date's fleet log, upserted by date).
  //   Action B -> UPSERT each worked element into ElementTracker (forward-only stage).
  saveMachinesAndElements_(ss, date, machine);

  return ss.getUrl();
}

/** Count machines whose state is not Idle (Active or Maintenance) for the flat column. */
function countActive_(list) {
  return (list || []).filter(function (m) {
    return m && String(m.machineState || m.status || '').toLowerCase() !== 'idle';
  }).length;
}

/**
 * The tightly-coupled machine + lifecycle write. Loops the machineStatus fleets ONCE and
 * does both actions per machine, so the two datasets always update together.
 */
function saveMachinesAndElements_(ss, date, machine) {
  machine = machine || { bcCutters: [], boringRigs: [] };
  var fleet = (machine.bcCutters || []).concat(machine.boringRigs || []);

  // Load ElementTracker once into an id-keyed map (forward-only upsert, then write back).
  var elSheet = ss.getSheetByName(TABS.elementTracker);
  var elMap = {}, elOrder = [];
  if (elSheet && elSheet.getLastRow() > 1) {
    readTable_(ss, TABS.elementTracker).forEach(function (r) {
      var id = String(r.element_id == null ? '' : r.element_id).trim();
      if (!id) return;
      var key = id.toUpperCase().replace(/\s+/g, '');
      if (!elMap[key]) elOrder.push(key);
      elMap[key] = {
        element_id: id, type: r.type || '', area: r.area || '', location: r.location || '',
        lifecycle_stage: r.lifecycle_stage || '', last_machine: r.last_machine || '',
        first_seen: toDateStr_(r.first_seen) || '', last_updated: toDateStr_(r.last_updated) || ''
      };
    });
  }

  var logRows = [];
  fleet.forEach(function (m) {
    m = m || {};
    var family = m.family || '';
    var els = Array.isArray(m.workingOnElements) ? m.workingOnElements : [];
    // Action A — daily machine log row.
    var elemStr = els.map(function (e) {
      var s = (e.elementId || '') + ':' + (e.lifecycleStage || '');
      if (e.depth != null && e.depth !== '' && Number(e.depth) > 0) s += '@' + e.depth + 'm';
      return s;
    }).filter(function (s) { return s !== ':'; }).join(', ');
    logRows.push([date, m.machineId || '', family, m.area || '', m.location || '',
      m.machineState || '', elemStr, m.evidence || '']);

    // Action B — upsert each element's lifecycle (advance only).
    els.forEach(function (e) {
      e = e || {};
      var id = String(e.elementId == null ? '' : e.elementId).trim();
      if (!id) return;
      var key = id.toUpperCase().replace(/\s+/g, '');
      var type = classifyElement_(id) || '';
      var cur = elMap[key];
      if (!cur) {
        elMap[key] = { element_id: id, type: type, area: m.area || '', location: m.location || '',
          lifecycle_stage: clampLifecycle_(e.lifecycleStage) || '', last_machine: m.machineId || '',
          first_seen: date, last_updated: date };
        elOrder.push(key);
      } else {
        var advanced = elementStageForward_(cur.lifecycle_stage, e.lifecycleStage);
        cur.lifecycle_stage = advanced || cur.lifecycle_stage;
        if (m.area) cur.area = m.area;
        if (m.location) cur.location = m.location;
        if (type) cur.type = type;
        cur.last_machine = m.machineId || cur.last_machine;
        cur.last_updated = date;
      }
    });
  });

  // Action A write — replace this date's rows, keep other days.
  upsertByDate_(ss, TABS.machineLogs, MACHINE_LOG_HEADER, 0, logRows);

  // Action B write — persist the whole ElementTracker (id-keyed, cross-day).
  var elRows = elOrder.map(function (k) {
    var r = elMap[k];
    return [r.element_id, r.type, r.area, r.location, r.lifecycle_stage, r.last_machine, r.first_seen, r.last_updated];
  });
  writeTable_(ss, TABS.elementTracker, ELEMENT_TRACKER_HEADER, elRows);
}

/**
 * Inline edit from the Viewer: overwrite one Activities row's section / activity /
 * manpower (Area and Date are kept). `edit` = {row, date, section, activity,
 * manpower, orig:{section,activity,manpower}}. The `orig` snapshot is checked
 * against the live cells so a stale row (someone re-saved the day meanwhile) is
 * rejected instead of overwriting the wrong record. Returns the new totalManpower
 * for that date so the Viewer can refresh its KPI without a full reload.
 */
function saveActivityEdit(edit) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(TABS.activities);
  if (!sheet) throw new Error('No Activities tab yet — Save from the uploader first.');
  var row = Number(edit && edit.row);
  if (!(row >= 2 && row <= sheet.getLastRow())) {
    throw new Error('Row out of range — click Refresh, then edit again.');
  }
  // Columns: [date, area, section, element_id, activity, manpower, stage]
  var cur = sheet.getRange(row, 1, 1, 7).getValues()[0];
  if (edit.orig) {
    if (String(edit.orig.section) !== String(cur[2]) ||
        String(edit.orig.activity) !== String(cur[4]) ||
        (Number(edit.orig.manpower) || 0) !== (Number(cur[5]) || 0)) {
      throw new Error('This row changed since you loaded it — click Refresh, then edit again.');
    }
  }
  // Area (col 2) is written only when the edit carries one (backward compatible).
  if (Object.prototype.hasOwnProperty.call(edit, 'area')) {
    sheet.getRange(row, 2).setValue(edit.area == null ? '' : edit.area);
  }
  sheet.getRange(row, 3, 1, 5).setValues([[
    edit.section == null ? '' : edit.section,
    edit.elementId == null ? String(cur[3] || '') : edit.elementId,
    edit.activity == null ? '' : edit.activity,
    Number(edit.manpower) || 0,
    edit.stage == null ? String(cur[6] || '') : edit.stage
  ]]);

  // Recompute that date's total manpower from the Activities tab and mirror it
  // into the Productivity row so the KPI stays consistent with the edits.
  var date = toDateStr_(cur[0]);
  var total = sumManpowerForDate_(sheet, date);
  updateProductivityManpower_(ss, date, total);
  return total;
}

/**
 * Add a new activity from the Viewer. `rec` = {date, area, section, activity,
 * manpower}. Appends to the Activities tab (creating it if needed), derives the
 * Area from the section when blank, ensures a Productivity row exists for the
 * date, and refreshes that date's total manpower. Returns the new totalManpower.
 */
function addActivity(rec) {
  var ss = getSpreadsheet_();
  var date = toDateStr_(rec && rec.date);
  if (!date) throw new Error('Pick a date for the new activity.');
  var activity = String(rec.activity == null ? '' : rec.activity).trim();
  if (!activity) throw new Error('Activity description is required.');
  var section = String(rec.section == null ? '' : rec.section).trim();
  var area = String(rec.area == null ? '' : rec.area).trim() || areaFromSection_(section) || '';

  var sheet = ss.getSheetByName(TABS.activities);
  if (!sheet || sheet.getLastRow() === 0) {
    writeTable_(ss, TABS.activities, ACTIVITY_HEADER, []);
    sheet = ss.getSheetByName(TABS.activities);
  }
  sheet.appendRow([date, area, section, String(rec.elementId == null ? '' : rec.elementId),
    activity, Number(rec.manpower) || 0, String(rec.stage == null ? '' : rec.stage)]);

  ensureProductivityRow_(ss, date);
  var total = sumManpowerForDate_(sheet, date);
  updateProductivityManpower_(ss, date, total);
  return total;
}

/**
 * Delete one Activities row from the Viewer. `edit` = {row, orig:{section,
 * activity, manpower}}. The orig snapshot guards against deleting the wrong row
 * if the sheet shifted. Refreshes that date's total manpower. Returns it.
 */
function deleteActivity(edit) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(TABS.activities);
  if (!sheet) throw new Error('No Activities tab.');
  var row = Number(edit && edit.row);
  if (!(row >= 2 && row <= sheet.getLastRow())) {
    throw new Error('Row out of range — click Refresh, then delete again.');
  }
  // Columns: [date, area, section, element_id, activity, manpower, stage]
  var cur = sheet.getRange(row, 1, 1, 7).getValues()[0];
  if (edit.orig) {
    if (String(edit.orig.section) !== String(cur[2]) ||
        String(edit.orig.activity) !== String(cur[4]) ||
        (Number(edit.orig.manpower) || 0) !== (Number(cur[5]) || 0)) {
      throw new Error('This row changed since you loaded it — click Refresh, then delete again.');
    }
  }
  var date = toDateStr_(cur[0]);
  sheet.deleteRow(row);
  var total = sheet.getLastRow() > 1 ? sumManpowerForDate_(sheet, date) : 0;
  updateProductivityManpower_(ss, date, total);
  return total;
}

/** Ensure a Productivity row exists for `date` (zeroed if new), so KPIs show it. */
function ensureProductivityRow_(ss, date) {
  var sheet = ss.getSheetByName(TABS.productivity);
  if (!sheet || sheet.getLastRow() === 0) {
    writeTable_(ss, TABS.productivity, PRODUCTIVITY_HEADER, []);
    sheet = ss.getSheetByName(TABS.productivity);
  }
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (toDateStr_(values[i][0]) === String(date)) return;
  }
  sheet.appendRow([date, 0, 0, 0, 0, 0, 0, '', '', '', '']);
}

/** Sum the manpower column of the Activities tab for one date. */
function sumManpowerForDate_(sheet, date) {
  var values = sheet.getDataRange().getValues();
  var sum = 0;
  for (var i = 1; i < values.length; i++) {
    if (toDateStr_(values[i][0]) === String(date)) sum += Number(values[i][5]) || 0;
  }
  return sum;
}

/** Write total_manpower into the Productivity row for `date` (if the row exists). */
function updateProductivityManpower_(ss, date, total) {
  var sheet = ss.getSheetByName(TABS.productivity);
  if (!sheet) return;
  var values = sheet.getDataRange().getValues();
  var col = PRODUCTIVITY_HEADER.indexOf('total_manpower'); // 0-based
  for (var i = 1; i < values.length; i++) {
    if (toDateStr_(values[i][0]) === String(date)) {
      sheet.getRange(i + 1, col + 1).setValue(total);
      return;
    }
  }
}

/**
 * Replace the rows for the date(s) present in `rows`, keep every other date, and
 * rewrite the tab. `dateCol` is the 0-based index of the date column.
 */
function upsertByDate_(ss, name, header, dateCol, rows) {
  var sheet = ss.getSheetByName(name);
  var existing = [];
  if (sheet) {
    var values = sheet.getDataRange().getValues();
    if (values.length > 1) existing = values.slice(1);
  }
  writeTable_(ss, name, header, mergeByDate_(existing, rows, dateCol));
}

/**
 * Pure merge: incoming rows replace their dates; other dates kept; sorted.
 * Keys are compared by NORMALISED date (toDateStr_) because existing rows come
 * back from Sheets as Date objects while new rows are ISO strings — comparing
 * raw String() values never matched, so every save used to append a duplicate.
 */
function mergeByDate_(existingRows, newRows, dateCol) {
  var incoming = {};
  newRows.forEach(function (r) { incoming[toDateStr_(r[dateCol])] = true; });
  var kept = existingRows.filter(function (r) { return !incoming[toDateStr_(r[dateCol])]; });
  var out = kept.concat(newRows);
  out.sort(function (a, b) {
    var x = toDateStr_(a[dateCol]), y = toDateStr_(b[dateCol]);
    return x < y ? -1 : (x > y ? 1 : 0);
  });
  return out;
}

/**
 * Read the productivity dashboard data for the Viewer: merged activities and the
 * productivity metric history (parsed for the charts), newest date first.
 */
function getReport() {
  var ss = getSpreadsheet_();
  // Activities: normalise the date so it always matches the Viewer's date filter
  // (Google Sheets may store "2026-08-05" as a Date object, not text).
  // Activities: drop exact-duplicate rows (artifacts of the old append bug) but
  // keep every genuinely distinct activity. Keep the last copy's sheet row.
  var actSeen = {};
  var activities = readTable_(ss, TABS.activities).map(function (row, i) {
    return {
      _row: i + 2,                       // 1-based sheet row (row 1 = header) for inline edits
      date: toDateStr_(row.date),
      area: String(row.area == null ? '' : row.area),
      section: String(row.section == null ? '' : row.section),
      elementId: String(row.element_id == null ? '' : row.element_id),
      activity: String(row.activity == null ? '' : row.activity),
      manpower: Number(row.manpower) || 0,
      stage: String(row.stage == null ? '' : row.stage) || stageFromText_(String(row.activity == null ? '' : row.activity))
    };
  }).filter(function (a) {
    var k = a.date + '|' + a.area + '|' + a.section + '|' + a.activity + '|' + a.manpower;
    if (actSeen[k]) return false; actSeen[k] = true; return true;
  });

  // Productivity: one row per date. If old duplicate rows exist, keep the last
  // (most recently saved) for each date so the dropdown/charts aren't repeated.
  var byDate = {};
  readTable_(ss, TABS.productivity).forEach(function (row) {
    var d = toDateStr_(row.date);
    byDate[d] = {
      date: d,
      dWallCount: Number(row.dwall_count) || 0,
      bPileCount: Number(row.bpile_count) || 0,
      bWallCount: Number(row.bwall_count) || 0,
      cWallCount: Number(row.cwall_count) || 0,
      concreteM3: Number(row.concrete_m3) || 0,
      totalManpower: Number(row.total_manpower) || 0,
      activeDWalls: splitList_(row.active_dwalls),
      activeBoredPiles: splitList_(row.active_bpiles),
      activeButtressWalls: splitList_(row.active_bwalls),
      activeCrossWalls: splitList_(row.active_crosswalls)
    };
  });
  var prod = Object.keys(byDate).map(function (k) { return byDate[k]; })
    .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  // DailySummaries: parse the three JSON pillar columns back into objects (guarded), one
  // per date (last row wins). Missing/blank -> empty defaults so the Viewer never breaks.
  function parseJson_(v, dflt) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return dflt;
    try { return JSON.parse(s); } catch (e) { return dflt; }
  }
  var sumByDate = {};
  readTable_(ss, TABS.summaries).forEach(function (row) {
    var d = toDateStr_(row.date);
    if (!d) return;
    sumByDate[d] = {
      date: d,
      totalConcreteM3: Number(row.total_concrete_m3) || 0,
      totalLoads: Number(row.total_loads) || 0,
      activeCutters: Number(row.active_cutters) || 0,
      activeRigs: Number(row.active_rigs) || 0,
      machineStatus: parseJson_(row.machine_status_json, { bcCutters: [], boringRigs: [] }),
      excavation: parseJson_(row.excavation_json, { totalVolumeOrLoads: 0, activeExcavations: [] }),
      reinforcedConcrete: parseJson_(row.rc_json, { totalConcreteVolumeM3: 0, rcActivities: [] })
    };
  });
  var summaries = Object.keys(sumByDate).map(function (k) { return sumByDate[k]; })
    .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  // ElementTracker: the persistent forward-only lifecycle stage per element id, so the
  // machine cards can show each element's *tracked* stage (id -> stage).
  var elementStages = {};
  readTable_(ss, TABS.elementTracker).forEach(function (r) {
    var id = String(r.element_id == null ? '' : r.element_id).trim();
    if (id) elementStages[id.toUpperCase().replace(/\s+/g, '')] = String(r.lifecycle_stage || '');
  });

  // Static soil-volume tracker (Tunnel / FB): the user-maintained planned vs cumulative m3.
  ensureExcavationProgress_(ss);
  var excavationProgress = readTable_(ss, TABS.excavationProgress).map(function (r) {
    return {
      zone: String(r.zone == null ? '' : r.zone).trim(),
      category: String(r.category == null ? '' : r.category).trim(),
      description: String(r.description == null ? '' : r.description).trim(),
      plannedM3: Number(r.planned_m3) || 0,
      cumulativeM3: Number(r.cumulative_m3) || 0,
      updated: String(r.updated == null ? '' : r.updated).trim()
    };
  }).filter(function (r) { return r.zone; });

  // Daily soil log (user-maintained): date/zone/m3, rolled up D/W/M in the Viewer.
  ensureExcavationDaily_(ss);
  var excavationDaily = readTable_(ss, TABS.excavationDaily).map(function (r) {
    return {
      date: toDateStr_(r.date),
      zone: String(r.zone == null ? '' : r.zone).trim() || 'Site',
      m3: Number(r.m3) || 0,
      note: String(r.note == null ? '' : r.note).trim()
    };
  }).filter(function (r) { return r.date && r.m3 > 0; });

  return {
    activities: activities,
    productivity: prod,
    summaries: summaries,
    elementStages: elementStages,
    excavationProgress: excavationProgress,
    excavationDaily: excavationDaily,
    config: { loadsToM3: loadsToM3_(),
      segmentArea: (PARSER_CONFIG.locator && PARSER_CONFIG.locator.segmentArea) || {},
      sectionArea: (PARSER_CONFIG.locator && PARSER_CONFIG.locator.sectionArea) || {} },
    spreadsheetUrl: ss.getUrl(),
    spreadsheetName: ss.getName()
  };
}

/**
 * MAINTENANCE — run once from the editor to physically remove duplicate rows the
 * old append bug left in the sheet (Activities: exact-duplicate rows; Productivity:
 * extra rows for the same date, keeping the last). Also normalises the stored date
 * to text. getReport already hides duplicates, but running this keeps inline edits
 * from resurfacing an old copy.
 */
function cleanupDuplicates() {
  var ss = getSpreadsheet_();
  var seen = {}, arows = [];
  readTable_(ss, TABS.activities).forEach(function (r) {
    var row = [toDateStr_(r.date), r.area || '', r.section || '', r.element_id || '',
      r.activity || '', Number(r.manpower) || 0, r.stage || ''];
    var k = row.join('|');
    if (!seen[k]) { seen[k] = 1; arows.push(row); }
  });
  arows.sort(function (a, b) { return String(a[0]) < String(b[0]) ? -1 : (String(a[0]) > String(b[0]) ? 1 : 0); });
  writeTable_(ss, TABS.activities, ACTIVITY_HEADER, arows);

  var byDate = {};
  readTable_(ss, TABS.productivity).forEach(function (r) {
    byDate[toDateStr_(r.date)] = [
      toDateStr_(r.date), Number(r.dwall_count) || 0, Number(r.bpile_count) || 0,
      Number(r.bwall_count) || 0, Number(r.cwall_count) || 0, Number(r.concrete_m3) || 0,
      Number(r.total_manpower) || 0, r.active_dwalls || '', r.active_bpiles || '',
      r.active_bwalls || '', r.active_crosswalls || ''
    ];
  });
  var prows = Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
  writeTable_(ss, TABS.productivity, PRODUCTIVITY_HEADER, prows);

  Logger.log('Cleanup done: ' + arows.length + ' activity rows, ' + prows.length + ' productivity days.');
  return { activities: arows.length, days: prows.length };
}

/** Normalise a cell value to "YYYY-MM-DD" whether Sheets returns text or a Date. */
function toDateStr_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    var y = v.getFullYear();
    var m = ('0' + (v.getMonth() + 1)).slice(-2);
    var d = ('0' + v.getDate()).slice(-2);
    return y + '-' + m + '-' + d;
  }
  return String(v == null ? '' : v).trim();
}

function splitList_(v) {
  return String(v == null ? '' : v).split(/[,;]\s*/).map(function (s) { return s.trim(); })
    .filter(Boolean);
}

function readTable_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0];
  return values.slice(1).map(function (row) {
    var o = {};
    header.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

function getSpreadsheet_() {
  if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('No spreadsheet configured. Set SPREADSHEET_ID in Code.gs, ' +
                  'or bind this script to a Google Sheet.');
}

/** Replace a tab's contents with a header row + rows. Creates the tab if needed. */
function writeTable_(ss, name, header, rows) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.clearContents();
  var data = [header].concat(rows.length ? rows : []);
  sheet.getRange(1, 1, data.length, header.length).setValues(
    data.map(function (row) {
      // pad short rows so setValues gets a rectangular array
      var r = row.slice();
      while (r.length < header.length) r.push('');
      return r;
    })
  );
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, header.length).setFontWeight('bold');
}

/**
 * Ensure the static Excavation soil-volume tracker tab exists, seeded with the two zones
 * (Tunnel / FB) and the user's current planned/cumulative m3. Never overwrites once created,
 * so the user's own edits (or pastes from their spreadsheet) persist.
 */
function ensureExcavationProgress_(ss) {
  var sheet = ss.getSheetByName(TABS.excavationProgress);
  if (sheet && sheet.getLastRow() >= 1) return sheet;
  if (!sheet) sheet = ss.insertSheet(TABS.excavationProgress);
  writeTable_(ss, TABS.excavationProgress, EXCAV_PROGRESS_HEADER, EXCAV_PROGRESS_SEED);
  return ss.getSheetByName(TABS.excavationProgress);
}

/**
 * Ensure the daily soil-log tab exists (header only — the user fills it or pastes from their
 * spreadsheet's Daily_Log). Never seeded with data and never overwritten.
 */
function ensureExcavationDaily_(ss) {
  var sheet = ss.getSheetByName(TABS.excavationDaily);
  if (sheet && sheet.getLastRow() >= 1) return sheet;
  if (!sheet) sheet = ss.insertSheet(TABS.excavationDaily);
  writeTable_(ss, TABS.excavationDaily, EXCAV_DAILY_HEADER, []);
  return ss.getSheetByName(TABS.excavationDaily);
}

/** Loads -> m3 conversion factor for the reported-this-range readout (Script Property, default 6). */
function loadsToM3_() {
  var v = Number(PropertiesService.getScriptProperties().getProperty('LOADS_TO_M3'));
  return (isFinite(v) && v > 0) ? v : 6;
}
