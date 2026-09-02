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
var SPREADSHEET_ID = '1njkQDQ8gGjojRx9otdO6JXU210WNpj5QggChTmkFXv8';

var TABS = {
  activities: 'Activities',      // one row per merged activity (per date)
  productivity: 'Productivity'   // one row per date: DW/BP/BT/CW counts, concrete m3, manpower
};

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
}

// Bump this on every deploy so the running version is visible in the browser —
// if the Viewer doesn't show this string, the deployed code is stale/wrong.
var APP_VERSION = 'build-12 · productivity + edit';

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
    mergedActivities: prod.mergedActivities,
    productivityData: prod.productivityData
  };
}

var ACTIVITY_HEADER = ['date', 'area', 'section', 'activity', 'manpower'];
var PRODUCTIVITY_HEADER = ['date', 'dwall_count', 'bpile_count', 'bwall_count', 'cwall_count',
  'concrete_m3', 'total_manpower', 'active_dwalls', 'active_bpiles', 'active_bwalls', 'active_crosswalls'];

/**
 * Persist the productivity result. `result` is what runComparison returned.
 * Upserts by date so history accumulates for the charts. Returns the sheet URL.
 */
function saveToSheet(result) {
  var ss = getSpreadsheet_();
  var date = result.date || result.reportDate || '';

  // Activities: one row per merged activity (all rows for this date replaced).
  upsertByDate_(ss, TABS.activities, ACTIVITY_HEADER, 0,
    (result.mergedActivities || []).map(function (a) {
      return [date, a.area || '', a.section || '', a.activity || '', a.manpower || 0];
    }));

  // Productivity: one row per date (metrics for the charts).
  var p = result.productivityData || {};
  upsertByDate_(ss, TABS.productivity, PRODUCTIVITY_HEADER, 0, [[
    date, p.dWallCount || 0, p.bPileCount || 0, p.bWallCount || 0, p.cWallCount || 0,
    p.totalConcreteVolumeM3 || 0, p.totalManpower || 0,
    (p.activeDWalls || []).join(', '), (p.activeBoredPiles || []).join(', '),
    (p.activeButtressWalls || []).join(', '), (p.activeCrossWalls || []).join(', ')
  ]]);

  return ss.getUrl();
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
  var cur = sheet.getRange(row, 1, 1, 5).getValues()[0]; // [date, area, section, activity, manpower]
  if (edit.orig) {
    if (String(edit.orig.section) !== String(cur[2]) ||
        String(edit.orig.activity) !== String(cur[3]) ||
        (Number(edit.orig.manpower) || 0) !== (Number(cur[4]) || 0)) {
      throw new Error('This row changed since you loaded it — click Refresh, then edit again.');
    }
  }
  sheet.getRange(row, 3, 1, 3).setValues([[
    edit.section == null ? '' : edit.section,
    edit.activity == null ? '' : edit.activity,
    Number(edit.manpower) || 0
  ]]);

  // Recompute that date's total manpower from the Activities tab and mirror it
  // into the Productivity row so the KPI stays consistent with the edits.
  var date = toDateStr_(cur[0]);
  var total = sumManpowerForDate_(sheet, date);
  updateProductivityManpower_(ss, date, total);
  return total;
}

/** Sum the manpower column of the Activities tab for one date. */
function sumManpowerForDate_(sheet, date) {
  var values = sheet.getDataRange().getValues();
  var sum = 0;
  for (var i = 1; i < values.length; i++) {
    if (toDateStr_(values[i][0]) === String(date)) sum += Number(values[i][4]) || 0;
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

/** Pure merge: incoming rows replace their dates; other dates kept; sorted. */
function mergeByDate_(existingRows, newRows, dateCol) {
  var incoming = {};
  newRows.forEach(function (r) { incoming[String(r[dateCol])] = true; });
  var kept = existingRows.filter(function (r) { return !incoming[String(r[dateCol])]; });
  var out = kept.concat(newRows);
  out.sort(function (a, b) {
    var x = String(a[dateCol]), y = String(b[dateCol]);
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
  var activities = readTable_(ss, TABS.activities).map(function (row, i) {
    return {
      _row: i + 2,                       // 1-based sheet row (row 1 = header) for inline edits
      date: toDateStr_(row.date),
      area: String(row.area == null ? '' : row.area),
      section: String(row.section == null ? '' : row.section),
      activity: String(row.activity == null ? '' : row.activity),
      manpower: Number(row.manpower) || 0
    };
  });
  var prod = readTable_(ss, TABS.productivity).map(function (row) {
    return {
      date: toDateStr_(row.date),
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
  }).sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  return {
    activities: activities,
    productivity: prod,
    spreadsheetUrl: ss.getUrl(),
    spreadsheetName: ss.getName()
  };
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
