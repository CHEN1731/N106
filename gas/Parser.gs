/**
 * Parser.gs — WhatsApp .txt export -> structured site records.
 *
 * Pure logic, no Apps Script services, so it runs identically in GAS and in the
 * Node test harness (test/run-tests.js).
 *
 * === CONFIG =========================================================
 * Tune this block to your real exports. Nothing below CONFIG needs editing
 * to adapt to a new message format or label wording.
 */
var PARSER_CONFIG = {
  // A "message start" line begins a new chat message. Two standard WhatsApp
  // formats are recognised; the parser auto-detects which one a file uses.
  //  - iOS:     [DD/MM/YY, HH:MM:SS] Sender: body
  //  - Android: DD/MM/YYYY, HH:MM - Sender: body
  lineFormats: [
    {
      name: 'ios',
      // [15/08/2026, 08:12:03] RTO Supervisor: message
      re: /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[APap][Mm])?\]\s*([^:]+):\s?([\s\S]*)$/
    },
    {
      name: 'android',
      // 15/08/2026, 08:12 - RTO Supervisor: message
      re: /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[APap][Mm])?\s*-\s*([^:]+):\s?([\s\S]*)$/
    }
  ],

  // In-body field labels (case-insensitive). If present they win over
  // heuristics; label wording can be extended here.
  labels: {
    date: ['date'],
    area: ['area', 'section', 'location', 'zone'],
    activity: ['activity', 'work', 'task'],
    remark: ['remark', 'remarks', 'note', 'notes']
  },

  // Known areas/sections for keyword fallback when no Area: label is present.
  // Matched case-insensitively as a substring of the message body.
  areaKeywords: [
    'Zone A', 'Zone B', 'Zone C', 'Zone D', 'Zone E',
    'Basement', 'Level 1', 'Level 2', 'Roof', 'External'
  ],

  // Lines/messages that are chat noise, not site records.
  systemPatterns: [
    /Messages and calls are end-to-end encrypted/i,
    /joined using this group's invite link/i,
    /changed the subject/i,
    /changed this group's icon/i,
    /added|removed|left|created group/i,
    /^\s*$/
  ],

  // Attachment / media markers -> counted as a photo on the current record.
  mediaPatterns: [
    /<Media omitted>/i,
    /image omitted/i,
    /photo omitted/i,
    /\.(jpg|jpeg|png|heic|webp)\b/i
  ],

  // A message only becomes a record if it carries site content. Require at
  // least a recognisable Activity (labelled or non-trivial body).
  minActivityLength: 3,

  // When true, a message must contain at least one recognised label
  // (Date:/Area:/Activity:/Remark:) to count as a site record. This keeps
  // greetings and free chatter out of the data. Flip to false for exports
  // whose records are NOT labelled and rely on keyword heuristics instead.
  requireLabelledRecord: true
};
// === END CONFIG =====================================================

/**
 * Parse a raw export into an array of message objects.
 * @param {string} text  raw WhatsApp .txt contents
 * @param {string} source  'RTO' or 'Samsung'
 * @return {Array<Object>} records
 */
function parseWhatsApp(text, source) {
  if (!text) return [];
  var lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var format = detectFormat_(lines);
  var messages = groupIntoMessages_(lines, format);
  var records = [];
  for (var i = 0; i < messages.length; i++) {
    var rec = messageToRecord_(messages[i], source);
    if (!rec) continue;
    if (rec._photoOnly) {
      // A standalone media message: credit its photos to the most recent
      // real record on the same day, if any.
      for (var j = records.length - 1; j >= 0; j--) {
        if (records[j].date === rec.date) { records[j].photos += rec.photos; break; }
      }
      continue;
    }
    records.push(rec);
  }
  return records;
}

/** Pick the line format that matches the most header lines. */
function detectFormat_(lines) {
  var best = PARSER_CONFIG.lineFormats[0];
  var bestHits = -1;
  for (var f = 0; f < PARSER_CONFIG.lineFormats.length; f++) {
    var fmt = PARSER_CONFIG.lineFormats[f];
    var hits = 0;
    for (var i = 0; i < lines.length; i++) {
      if (fmt.re.test(lines[i])) hits++;
    }
    if (hits > bestHits) { bestHits = hits; best = fmt; }
  }
  return best;
}

/** Fold continuation lines into their parent message. */
function groupIntoMessages_(lines, format) {
  var messages = [];
  var current = null;
  for (var i = 0; i < lines.length; i++) {
    var m = format.re.exec(lines[i]);
    if (m) {
      if (current) messages.push(current);
      current = {
        rawDate: m[1].trim(),
        rawTime: m[2].trim(),
        sender: m[3].trim(),
        body: (m[4] || '').trim(),
        lines: [lines[i]]
      };
    } else if (current) {
      current.body += '\n' + lines[i];
      current.lines.push(lines[i]);
    }
  }
  if (current) messages.push(current);
  return messages;
}

/** Convert one message into a site record, or null if it is not one. */
function messageToRecord_(msg, source) {
  var body = msg.body;

  if (isSystem_(body)) return null;

  // Pure media message -> attach a photo to the previous record instead of a
  // standalone record. Callers handle merge; here we surface it as a photo-only
  // marker the record builder folds in.
  var photos = countMedia_(body);
  var contentBody = stripMedia_(body);

  var fields = extractLabelled_(contentBody);
  var hasLabel = fields.date !== undefined || fields.area !== undefined ||
                 fields.activity !== undefined || fields.remark !== undefined;

  // Labelled-record mode: without a label this is chatter (or a media line).
  if (PARSER_CONFIG.requireLabelledRecord && !hasLabel) {
    if (photos > 0) return { _photoOnly: true, photos: photos, date: normalizeDate_(msg.rawDate) };
    return null;
  }

  var date = fields.date ? normalizeDate_(fields.date) : normalizeDate_(msg.rawDate);
  var area = fields.area || guessArea_(contentBody);
  var activity = fields.activity || guessActivity_(contentBody, fields);
  var remark = fields.remark || '';

  // Need a resolvable area AND activity to be a usable comparison record.
  var hasContent = area && activity && activity.length >= PARSER_CONFIG.minActivityLength;
  if (!hasContent) {
    if (photos > 0) return { _photoOnly: true, photos: photos, date: date };
    return null;
  }

  return {
    source: source,
    date: date,
    area: (area || '').trim(),
    activity: (activity || '').trim(),
    remark: (remark || '').trim(),
    photos: photos,
    sender: msg.sender,
    rawTs: msg.rawDate + ' ' + msg.rawTime
  };
}

function isSystem_(body) {
  for (var i = 0; i < PARSER_CONFIG.systemPatterns.length; i++) {
    if (PARSER_CONFIG.systemPatterns[i].test(body)) return true;
  }
  return false;
}

function countMedia_(body) {
  var n = 0;
  for (var i = 0; i < PARSER_CONFIG.mediaPatterns.length; i++) {
    var re = new RegExp(PARSER_CONFIG.mediaPatterns[i].source, 'gi');
    var m = body.match(re);
    if (m) n += m.length;
  }
  return n;
}

function stripMedia_(body) {
  var out = body;
  for (var i = 0; i < PARSER_CONFIG.mediaPatterns.length; i++) {
    out = out.replace(new RegExp(PARSER_CONFIG.mediaPatterns[i].source, 'gi'), '');
  }
  return out.trim();
}

/** Pull "Label: value" fields out of the body based on CONFIG.labels. */
function extractLabelled_(body) {
  var result = {};
  var allLabels = [];
  var keyByLabel = {};
  for (var key in PARSER_CONFIG.labels) {
    var words = PARSER_CONFIG.labels[key];
    for (var w = 0; w < words.length; w++) {
      allLabels.push(words[w]);
      keyByLabel[words[w].toLowerCase()] = key;
    }
  }
  if (!allLabels.length) return result;

  // Split body on any label so a labelled value ends at the next label.
  var labelAlt = allLabels.map(escapeRe_).join('|');
  var re = new RegExp('(^|\\n|\\s)(' + labelAlt + ')\\s*[:：]\\s*', 'i');
  var rest = body;
  var guard = 0;
  while (guard++ < 50) {
    var m = re.exec(rest);
    if (!m) break;
    var labelWord = m[2].toLowerCase();
    var after = rest.slice(m.index + m[0].length);
    // value runs until the next label or end of body.
    var nextLabel = new RegExp('(\\n|\\s)(' + labelAlt + ')\\s*[:：]', 'i').exec(after);
    var value = nextLabel ? after.slice(0, nextLabel.index) : after;
    var key = keyByLabel[labelWord];
    if (key && result[key] === undefined) result[key] = value.trim();
    rest = nextLabel ? after.slice(nextLabel.index) : '';
  }
  return result;
}

/** Substring match against known areas. */
function guessArea_(body) {
  for (var i = 0; i < PARSER_CONFIG.areaKeywords.length; i++) {
    var kw = PARSER_CONFIG.areaKeywords[i];
    if (new RegExp(escapeRe_(kw), 'i').test(body)) return kw;
  }
  return '';
}

/** When no Activity label, use the first non-empty line of the body. */
function guessActivity_(body, fields) {
  var text = body;
  // Remove any labelled segments we already captured.
  for (var key in fields) {
    if (fields[key]) text = text.replace(fields[key], '');
  }
  var line = text.split('\n').map(function (s) { return s.trim(); })
                 .filter(function (s) { return s.length > 0; })[0];
  return line || '';
}

/** Normalise D/M/Y (or D/M/YY) to ISO yyyy-mm-dd. */
function normalizeDate_(raw) {
  if (!raw) return '';
  var m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(raw);
  if (!m) return String(raw).trim();
  var d = m[1], mo = m[2], y = m[3];
  if (y.length === 2) y = '20' + y;
  return y + '-' + pad2_(mo) + '-' + pad2_(d);
}

function pad2_(s) { s = String(s); return s.length < 2 ? '0' + s : s; }
function escapeRe_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Export for Node test harness (ignored by Apps Script).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseWhatsApp: parseWhatsApp,
    normalizeDate_: normalizeDate_,
    PARSER_CONFIG: PARSER_CONFIG
  };
}
