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
  summary: 'DailySummary'
};

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('N106 — WhatsApp Site Record Accuracy')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Let Index.html pull in Styles.html and JavaScript.html. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Parse + compare. Called from the client with the (possibly edited) text of
 * both panes. Returns a plain object the client renders; nothing is persisted.
 */
function runComparison(rtoText, samsungText) {
  var rto = parseWhatsApp(rtoText, 'RTO');
  var sam = parseWhatsApp(samsungText, 'Samsung');
  var cmp = compareRecords(rto, sam);
  return {
    rtoCount: rto.length,
    samsungCount: sam.length,
    rows: cmp.rows,
    daily: cmp.daily,
    overall: cmp.overall,
    records: rto.concat(sam)
  };
}

/**
 * Persist a comparison result to the spreadsheet. `result` is exactly what
 * runComparison returned (re-sent from the client so the user saves what they
 * reviewed). Returns the spreadsheet URL.
 */
function saveToSheet(result) {
  var ss = getSpreadsheet_();

  writeTable_(ss, TABS.records,
    ['source', 'date', 'area_group', 'section', 'segment', 'area', 'activity',
     'remark', 'photos', 'sender', 'raw_ts'],
    (result.records || []).map(function (r) {
      return [r.source, r.date, r.areaGroup || '', r.section || '', r.segment || '',
              r.area, r.activity, r.remark, r.photos, r.sender, r.rawTs];
    }));

  writeTable_(ss, TABS.comparison,
    ['date', 'area_group', 'area', 'status', 'similarity', 'rto_activity',
     'samsung_activity', 'rto_remark', 'samsung_remark', 'rto_photos', 'samsung_photos'],
    (result.rows || []).map(function (r) {
      return [r.date, r.areaGroup || '', r.area, r.status, r.similarity, r.rtoActivity,
              r.samsungActivity, r.rtoRemark, r.samsungRemark, r.rtoPhotos, r.samsungPhotos];
    }));

  writeTable_(ss, TABS.summary,
    ['date', 'total_keys', 'matched', 'conflicts', 'missing', 'accuracy_pct'],
    (result.daily || []).map(function (d) {
      return [d.date, d.total, d.matched, d.conflicts, d.missing, d.accuracyPct];
    }));

  return ss.getUrl();
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
