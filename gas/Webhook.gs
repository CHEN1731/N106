/**
 * Webhook.gs — WhatsApp Business Cloud API (Meta) ingestion for N106.
 *
 * Full automation path (replaces manual paste/upload):
 *   Meta Cloud API  --POST-->  doPost(e)  -->  append raw message to Raw_Logs
 *   time-driven trigger  -->  processRawLogs()  -->  rebuild each affected day
 *       via the EXISTING pipeline: saveToSheet(generateProductivity(rto, ais, date))
 *       -> Activities / Productivity tabs (the Viewer reads these, unchanged).
 *
 * IMPORTANT — Apps Script only allows ONE doGet and ONE doPost per project:
 *   - doPost lives here (there was none before).
 *   - Meta's GET verification challenge is handled by handleWebhookGet_(e), which
 *     the existing doGet() in Code.gs calls first (see that file). We do NOT define
 *     a second doGet.
 *
 * Security notes (Apps Script limitations):
 *   - doPost(e) does NOT expose HTTP headers, so Meta's X-Hub-Signature-256 cannot
 *     be verified. Instead the callback URL carries a secret query token
 *     (?wt=<WHATSAPP_URL_TOKEN>); Meta calls the exact registered URL, so the token
 *     arrives on every POST. Unmatched tokens are ignored (still 200 so Meta stops
 *     retrying). When WHATSAPP_URL_TOKEN is unset, all POSTs are accepted (dev mode).
 *   - GET verification uses Meta's standard hub.verify_token vs WHATSAPP_VERIFY_TOKEN.
 *
 * Script Properties used (Project Settings -> Script properties):
 *   WHATSAPP_VERIFY_TOKEN  - any random string; also entered in Meta's webhook UI.
 *   WHATSAPP_URL_TOKEN     - secret appended to the callback URL as ?wt=...   (optional)
 *   WHATSAPP_SOURCE_MAP    - JSON {"<phone>":"RTO"|"AIS", ...}  maps sender -> source.
 *   (ANTHROPIC_API_KEY / CLAUDE_MODEL are read by Extract.gs as before.)
 */

var RAW_LOG_HEADER = ['received_at', 'wa_message_id', 'from_phone', 'sender_name',
  'source', 'msg_date', 'wa_timestamp', 'type', 'text', 'processed'];

/* ------------------------------------------------------------------ *
 * GET — Meta webhook verification challenge.
 * Called from doGet() in Code.gs BEFORE the normal HTML routing. Returns a
 * ContentService text output when this is a hub challenge, else null so the
 * page routing proceeds as usual.
 * ------------------------------------------------------------------ */
function handleWebhookGet_(e) {
  var p = (e && e.parameter) || {};
  if (p['hub.mode'] == null && p['hub.challenge'] == null && p['hub.verify_token'] == null) {
    return null; // not a webhook verification request
  }
  var expected = getScriptProp_('WHATSAPP_VERIFY_TOKEN');
  if (p['hub.mode'] === 'subscribe' && expected && p['hub.verify_token'] === expected) {
    return ContentService.createTextOutput(p['hub.challenge'] || '');
  }
  return ContentService.createTextOutput('Forbidden');
}

/* ------------------------------------------------------------------ *
 * POST — inbound WhatsApp messages. Log raw + return 200 fast.
 * Never throws: Meta retries aggressively on any non-200, so we swallow errors,
 * log them, and always answer 200 EVENT_RECEIVED.
 * ------------------------------------------------------------------ */
function doPost(e) {
  try {
    // URL-token guard (see header notes). Accept when no token is configured.
    var urlToken = getScriptProp_('WHATSAPP_URL_TOKEN');
    if (urlToken) {
      var got = (e && e.parameter && (e.parameter.wt || e.parameter.token)) || '';
      if (got !== urlToken) {
        console.warn('doPost: URL token mismatch — ignoring payload.');
        return webhookOk_();
      }
    }

    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var msgs = parseWebhookMessages_(body);
    if (msgs.length) {
      var ss = getSpreadsheet_();
      var sheet = getRawLogSheet_(ss);
      var now = new Date();
      msgs.forEach(function (m) {
        sheet.appendRow([
          now,
          m.waId || '',
          m.from || '',
          m.name || '',
          phoneSource_(m.from),
          waTimestampToDate_(m.timestamp),
          m.timestamp || '',
          m.type || '',
          m.text || '',
          false
        ]);
      });
    }
  } catch (err) {
    try { console.error('doPost error: ' + err); } catch (e2) {}
  }
  return webhookOk_();
}

function webhookOk_() {
  return ContentService.createTextOutput('EVENT_RECEIVED');
}

/* ------------------------------------------------------------------ *
 * Pure: extract message rows from a Cloud API webhook payload.
 * Shape: body.entry[].changes[].value.messages[] with value.contacts[] for names.
 * Returns [{waId, from, timestamp, type, text, name}]. Non-text messages keep an
 * empty text (logged for audit); status/read receipts are skipped.
 * ------------------------------------------------------------------ */
function parseWebhookMessages_(body) {
  var out = [];
  if (!body || body.object !== 'whatsapp_business_account') return out;
  (body.entry || []).forEach(function (entry) {
    (entry.changes || []).forEach(function (change) {
      var value = change && change.value;
      if (!value) return;
      // Map phone -> profile name from contacts[].
      var names = {};
      (value.contacts || []).forEach(function (c) {
        if (c && c.wa_id) names[c.wa_id] = (c.profile && c.profile.name) || '';
      });
      (value.messages || []).forEach(function (msg) {
        if (!msg) return;
        var type = msg.type || '';
        var text = '';
        if (type === 'text' && msg.text) text = msg.text.body || '';
        else if (type === 'button' && msg.button) text = msg.button.text || '';
        else if (msg.caption) text = msg.caption; // image/video with caption
        out.push({
          waId: msg.id || '',
          from: msg.from || '',
          timestamp: msg.timestamp || '',
          type: type,
          text: text,
          name: names[msg.from] || ''
        });
      });
    });
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * Pure-ish: map a sender phone to a source (RTO/AIS). Reads the JSON map from
 * Script Property WHATSAPP_SOURCE_MAP unless one is passed in (for tests).
 * Unknown/blank -> 'RTO' (default stream).
 * ------------------------------------------------------------------ */
function phoneSource_(phone, mapOverride) {
  var map = mapOverride;
  if (!map) {
    var raw = getScriptProp_('WHATSAPP_SOURCE_MAP');
    if (raw) { try { map = JSON.parse(raw); } catch (e) { map = {}; } }
    else map = {};
  }
  var key = normalizePhone_(phone);
  if (map[key]) return map[key];
  // also try the raw form as given
  if (phone && map[String(phone)]) return map[String(phone)];
  return 'RTO';
}

/** Strip non-digits so "+60 12-345 6789" and "60123456789" match the same key. */
function normalizePhone_(phone) {
  return String(phone == null ? '' : phone).replace(/\D/g, '');
}

/* ------------------------------------------------------------------ *
 * Convert a WhatsApp unix timestamp (seconds, string or number) to yyyy-mm-dd
 * in the project timezone. Reuses toDateStr_ (Code.gs) so it works in Node tests.
 * ------------------------------------------------------------------ */
function waTimestampToDate_(ts) {
  var n = Number(ts);
  if (!n) return '';
  return toDateStr_(new Date(n * 1000));
}

/* ------------------------------------------------------------------ *
 * Pure: split the day's raw rows into RTO / AIS text blobs for the pipeline.
 * `rows` = [{waId, source, text}]. Dedups by waId, drops empty text, joins one
 * message per line. Unknown sources fold into RTO.
 * ------------------------------------------------------------------ */
function buildDayTexts_(rows) {
  var seen = {}, rto = [], ais = [];
  (rows || []).forEach(function (r) {
    var id = r.waId || '';
    if (id) { if (seen[id]) return; seen[id] = 1; }
    var text = String(r.text == null ? '' : r.text).trim();
    if (!text) return;
    if (String(r.source).toUpperCase() === 'AIS') ais.push(text);
    else rto.push(text);
  });
  return { rto: rto.join('\n'), ais: ais.join('\n') };
}

/* ------------------------------------------------------------------ *
 * Scheduled batch job (time-driven trigger -> installWebhookTrigger_).
 * Rebuilds every date that has an unprocessed Raw_Logs row from ALL of that
 * date's raw rows, then marks them processed. Idempotent (saveToSheet upserts by
 * date). Returns the list of dates rebuilt.
 * ------------------------------------------------------------------ */
function processRawLogs() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(TABS.raw);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var values = sheet.getDataRange().getValues();
  var header = values[0];
  var col = {};
  header.forEach(function (h, i) { col[h] = i; });
  var iDate = col.msg_date, iSource = col.source, iText = col.text,
      iId = col.wa_message_id, iProcessed = col.processed;

  // Collect rows (1-based sheet row index) grouped by date; note which dates are dirty.
  var byDate = {}, dirty = {};
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var date = toDateStr_(row[iDate]);
    if (!date) continue;
    (byDate[date] || (byDate[date] = [])).push({
      sheetRow: r + 1,
      waId: String(row[iId] == null ? '' : row[iId]),
      source: String(row[iSource] == null ? '' : row[iSource]),
      text: String(row[iText] == null ? '' : row[iText])
    });
    if (row[iProcessed] !== true) dirty[date] = true;
  }

  var rebuilt = [];
  Object.keys(dirty).forEach(function (date) {
    var rows = byDate[date];
    var texts = buildDayTexts_(rows);
    try {
      saveToSheet(generateProductivity(texts.rto, texts.ais, date));
      rows.forEach(function (rr) { sheet.getRange(rr.sheetRow, iProcessed + 1).setValue(true); });
      rebuilt.push(date);
    } catch (err) {
      try { console.error('processRawLogs failed for ' + date + ': ' + err); } catch (e) {}
    }
  });
  return rebuilt;
}

/* ------------------------------------------------------------------ *
 * One-time setup helpers (run from the editor).
 * ------------------------------------------------------------------ */

/** Create the hourly trigger for processRawLogs (skips if one already exists). */
function installWebhookTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'processRawLogs';
  });
  if (exists) { Logger.log('processRawLogs trigger already installed.'); return; }
  ScriptApp.newTrigger('processRawLogs').timeBased().everyHours(1).create();
  Logger.log('Installed hourly processRawLogs trigger.');
}

/** DIAGNOSTIC — run processRawLogs now and log which dates were rebuilt. */
function debugProcessRawLogs() {
  var dates = processRawLogs();
  Logger.log('processRawLogs rebuilt ' + dates.length + ' day(s): ' + dates.join(', '));
}

/* ------------------------------------------------------------------ *
 * Sheet + property helpers.
 * ------------------------------------------------------------------ */

/** Get (or create with header) the Raw_Logs tab. */
function getRawLogSheet_(ss) {
  var sheet = ss.getSheetByName(TABS.raw);
  if (!sheet) {
    sheet = ss.insertSheet(TABS.raw);
    sheet.getRange(1, 1, 1, RAW_LOG_HEADER.length).setValues([RAW_LOG_HEADER]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, RAW_LOG_HEADER.length).setFontWeight('bold');
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, RAW_LOG_HEADER.length).setValues([RAW_LOG_HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getScriptProp_(name) {
  try { return PropertiesService.getScriptProperties().getProperty(name); }
  catch (e) { return null; }
}

// Export for the Node test harness (ignored by Apps Script).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseWebhookMessages_: parseWebhookMessages_,
    phoneSource_: phoneSource_,
    normalizePhone_: normalizePhone_,
    waTimestampToDate_: waTimestampToDate_,
    buildDayTexts_: buildDayTexts_
  };
}
