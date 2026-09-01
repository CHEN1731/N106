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

// Target spreadsheet. Leave blank to use the container-bound sheet (if the
// script is bound to a Sheet), or paste a spreadsheet ID for a standalone script.
var SPREADSHEET_ID = '';

var TABS = {
  records: 'Records',
  comparison: 'Comparison',
  summary: 'DailySummary',
  workSummary: 'WorkSummary'   // executive RTO-vs-AIS cross-comparison, one row per date
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
  var c = ss.getSheetByName(TABS.comparison);
  Logger.log('Comparison tab exists? ' + !!c + '  rows (incl header): ' +
    (c ? c.getDataRange().getValues().length : 'N/A'));
  Logger.log('--- all tabs in this spreadsheet ---');
  ss.getSheets().forEach(function (s) {
    Logger.log('tab "' + s.getName() + '"  lastRow=' + s.getLastRow());
  });
}

/**
 * Route:
 *   ?page=view  -> Viewer.html   (directors: interactive, editable report)
 *   (default)   -> Index.html    (you: upload / compare / save)
 */
function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) || '';
  var file = page === 'view' ? 'Viewer' : 'Index';
  var title = page === 'view'
    ? 'N106 — Site Record Report'
    : 'N106 — WhatsApp Site Record Accuracy';
  return HtmlService.createTemplateFromFile(file)
    .evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Let a template pull in its partial .html files (styles/scripts). */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Parse + compare. Called from the client with the (possibly edited) text of
 * both panes. Uses AI extraction when an API key is set (Extract.gs), else the
 * regex parser. Returns a plain object the client renders; nothing is persisted.
 */
function runComparison(rtoText, samsungText, reportDate) {
  // The AIS daily report is one day; the RTO WhatsApp export is often the whole
  // chat history. Scope RTO to the report's date so each day compares cleanly
  // (and the AI only processes that day). Priority: an explicit reportDate, else
  // the date(s) found in the AIS report, else no scoping.
  var ais = extractRecords('AIS', samsungText);
  var target = targetDates_(reportDate, ais);
  var rtoScoped = target ? sliceChatByDate_(rtoText, target) : rtoText;

  var rto = extractRecords('RTO', rtoScoped);
  if (target) { rto = filterByDates_(rto, target); ais = filterByDates_(ais, target); }

  var cmp = compareRecords(rto, ais);
  var summary = generateWorkSummary(rtoScoped, samsungText, target && target[0]);
  return {
    rtoCount: rto.length,
    samsungCount: ais.length,
    usedAi: !!getApiKey_(),
    reportDate: (target && target[0]) || '',
    rows: cmp.rows,
    daily: cmp.daily,
    overall: cmp.overall,
    records: rto.concat(ais),
    summary: summary
  };
}

/** Resolve which date(s) this run covers: explicit reportDate, else AIS dates. */
function targetDates_(reportDate, aisRecords) {
  if (reportDate) {
    var d = normalizeDate_(reportDate);
    return d ? [d] : null;
  }
  var seen = {}, out = [];
  (aisRecords || []).forEach(function (r) {
    if (r.date && !seen[r.date]) { seen[r.date] = true; out.push(r.date); }
  });
  return out.length ? out : null;
}

/**
 * Persist a comparison result to the spreadsheet. `result` is exactly what
 * runComparison returned (re-sent from the client so the user saves what they
 * reviewed). Returns the spreadsheet URL.
 */
function saveToSheet(result) {
  var ss = getSpreadsheet_();

  // Upsert by date so history accumulates across daily uploads: rows for the
  // date(s) in this upload replace only those dates; other days are untouched.
  upsertByDate_(ss, TABS.records,
    ['source', 'date', 'area_group', 'section', 'segment', 'area', 'activity',
     'remark', 'photos', 'sender', 'raw_ts'], 1,
    (result.records || []).map(function (r) {
      return [r.source, r.date, r.areaGroup || '', r.section || '', r.segment || '',
              r.area, r.activity, r.remark, r.photos, r.sender, r.rawTs];
    }));

  upsertByDate_(ss, TABS.comparison,
    ['date', 'area_group', 'area', 'status', 'similarity', 'rto_activity',
     'samsung_activity', 'rto_remark', 'samsung_remark', 'rto_photos', 'samsung_photos'], 0,
    (result.rows || []).map(function (r) {
      return [r.date, r.areaGroup || '', r.area, r.status, r.similarity, r.rtoActivity,
              r.samsungActivity, r.rtoRemark, r.samsungRemark, r.rtoPhotos, r.samsungPhotos];
    }));

  upsertByDate_(ss, TABS.summary,
    ['date', 'total_keys', 'matched', 'conflicts', 'missing', 'accuracy_pct'], 0,
    (result.daily || []).map(function (d) {
      return [d.date, d.total, d.matched, d.conflicts, d.missing, d.accuracyPct];
    }));

  if (result.summary) upsertWorkSummary_(ss, result.summary);

  return ss.getUrl();
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
    if (values.length > 1) existing = values.slice(1); // drop header
  }
  var merged = mergeByDate_(existing, rows, dateCol);
  writeTable_(ss, name, header, merged);
}

/**
 * Pure merge: drop existing rows whose date is among the incoming rows' dates,
 * then append the incoming rows; sorted by date. Exposed for testing.
 */
function mergeByDate_(existingRows, newRows, dateCol) {
  var incomingDates = {};
  newRows.forEach(function (r) { incomingDates[String(r[dateCol])] = true; });
  var kept = existingRows.filter(function (r) { return !incomingDates[String(r[dateCol])]; });
  var out = kept.concat(newRows);
  out.sort(function (a, b) {
    var x = String(a[dateCol]), y = String(b[dateCol]);
    return x < y ? -1 : (x > y ? 1 : 0);
  });
  return out;
}

/**
 * Upsert one executive summary row keyed by date (keeps history across days,
 * unlike the other tabs which reflect only the latest upload). The full summary
 * object is stored as JSON in the `json` column; flat columns aid at-a-glance
 * reading and any Looker use.
 */
function upsertWorkSummary_(ss, summary) {
  var header = ['date', 'status', 'executive_summary', 'discrepancy_count', 'source', 'json'];
  var sheet = ss.getSheetByName(TABS.workSummary);
  if (!sheet) {
    sheet = ss.insertSheet(TABS.workSummary);
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  var row = [
    summary.date || '',
    summary.status || '',
    (summary.executiveSummary || []).map(function (b) { return '• ' + b; }).join('\n'),
    (summary.discrepancies || []).length,
    summary.source || '',
    JSON.stringify(summary)
  ];
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(summary.date) && summary.date) {
      sheet.getRange(r + 1, 1, 1, header.length).setValues([row]);
      return;
    }
  }
  sheet.appendRow(row);
}

/**
 * Read the saved report for the Viewer page: the Comparison + DailySummary tabs
 * as arrays of objects (header row -> keys). Returns {} shape the viewer renders.
 */
function getReport() {
  var ss = getSpreadsheet_();
  return {
    comparison: readTable_(ss, TABS.comparison),
    daily: readTable_(ss, TABS.summary),
    records: readTable_(ss, TABS.records),
    summaries: readWorkSummaries_(ss),
    // Which spreadsheet the viewer actually read — so a "0 records" while the
    // sheet clearly has data instantly reveals a wrong-spreadsheet mismatch.
    spreadsheetUrl: ss.getUrl(),
    spreadsheetName: ss.getName()
  };
}

/** Read the WorkSummary tab back into full summary objects (newest first). */
function readWorkSummaries_(ss) {
  return readTable_(ss, TABS.workSummary).map(function (row) {
    try { return JSON.parse(row.json); }
    catch (e) {
      return { date: row.date, status: row.status,
               executiveSummary: String(row.executive_summary || '').split('\n')
                 .map(function (s) { return s.replace(/^•\s*/, ''); }).filter(Boolean),
               sectionBreakdown: [], discrepancies: [], manpowerAndRemarks: [],
               source: row.source };
    }
  }).sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
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

/**
 * Save an inline correction from the Viewer back to the Comparison tab.
 * `edit` = { date, area, field, value } — updates the matching row's column.
 * Returns true on success.
 */
function saveRecordEdit(edit) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(TABS.comparison);
  if (!sheet) throw new Error('No Comparison tab to edit.');
  var values = sheet.getDataRange().getValues();
  var header = values[0];
  var dateCol = header.indexOf('date');
  var areaCol = header.indexOf('area');
  var fieldCol = header.indexOf(edit.field);
  if (fieldCol < 0) throw new Error('Unknown field: ' + edit.field);
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][dateCol]) === String(edit.date) &&
        String(values[r][areaCol]) === String(edit.area)) {
      sheet.getRange(r + 1, fieldCol + 1).setValue(edit.value);
      return true;
    }
  }
  throw new Error('Row not found for ' + edit.date + ' / ' + edit.area);
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
