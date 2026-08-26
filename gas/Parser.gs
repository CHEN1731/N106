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

  // === AREA / SECTION LIST (the main thing to tune) ==================
  // Canonical sections and the free-text aliases that map to each. Any alias
  // (matched case-insensitively as a whole-word-ish substring) collapses to the
  // canonical name, so "zone b", "Zone-B", "basement zone B" all become one key
  // that lines RTO and Samsung records up. First matching area in this list wins,
  // so list more specific areas before broader ones. REPLACE with the real N106
  // sections + how each is written in the two chats.
  areas: [
    { name: 'Zone A', aliases: ['zone a', 'zone-a', 'zonea', 'blk a', 'block a'] },
    { name: 'Zone B', aliases: ['zone b', 'zone-b', 'zoneb', 'basement', 'blk b', 'block b'] },
    { name: 'Zone C', aliases: ['zone c', 'zone-c', 'zonec', 'roof', 'blk c', 'block c'] },
    { name: 'Zone D', aliases: ['zone d', 'zone-d', 'zoned', 'external', 'ext', 'blk d', 'block d'] },
    { name: 'Zone E', aliases: ['zone e', 'zone-e', 'zonee', 'blk e', 'block e'] },
    { name: 'Level 1', aliases: ['level 1', 'l1', 'lvl 1', '1st floor', 'first floor'] },
    { name: 'Level 2', aliases: ['level 2', 'l2', 'lvl 2', '2nd floor', 'second floor'] }
  ],

  // Fallback area for a message that has real site content but no area match.
  defaultArea: 'General',

  // Free-text signals that a no-area message is still a site record (so it goes
  // to the General bucket rather than being dropped). Extend with your trades.
  activityKeywords: [
    'pour', 'concrete', 'rebar', 'reinforce', 'formwork', 'form work', 'install',
    'installation', 'waterproof', 'membrane', 'clear', 'clearance', 'excavat',
    'backfill', 'scaffold', 'plaster', 'screed', 'block', 'brick', 'steel',
    'weld', 'paint', 'tiling', 'tile', 'inspect', 'inspection', 'test', 'delivery',
    'deliver', 'progress', 'complete', 'completed', 'ongoing', 'defect', 'crane'
  ],

  // Messages matching any of these (and carrying no area / activity signal) are
  // treated as chatter and skipped, so General does not fill with greetings.
  chatterPatterns: [
    /^\s*(good\s*(morning|afternoon|evening|night))\b/i,
    /^\s*(hi|hello|hey|thanks?|thank you|ok(ay)?|noted|received|welcome|sure|yes|no)\b[\s.!]*$/i,
    /daily report (starting|start)/i,
    /site log\s*$/i
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

  // A message only becomes a record if it carries site content of this length.
  minActivityLength: 3,

  // Free-form mode (default). When false, a message must contain a recognised
  // label (Date:/Area:/Activity:/Remark:) to count — use only if your exports
  // are strictly a labelled template. Labelled fields are always honored when
  // present, so free-form mode still parses labelled messages correctly.
  requireLabelledRecord: false
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

  // Resolve the section: a labelled Area: (canonicalised) wins; otherwise scan
  // the free text for a known area alias. May be '' (no area found).
  var area = fields.area !== undefined
    ? canonicalizeAreaValue_(fields.area)
    : canonicalArea_(contentBody);

  // Does this free-text message look like a site record at all?
  var hasSignal = hasActivitySignal_(contentBody);
  var isCandidate = hasLabel || !!area || hasSignal;
  if (!isCandidate || (isChatter_(contentBody) && !area && !hasSignal)) {
    if (photos > 0) return { _photoOnly: true, photos: photos, date: date };
    return null;
  }

  // Build activity/remark: labelled fields win, else split the free text.
  var ar;
  if (fields.activity !== undefined || fields.remark !== undefined) {
    ar = { activity: fields.activity || '', remark: fields.remark || '' };
    if (!ar.activity) ar = splitFreeForm_(contentBody, fields);
  } else {
    ar = splitFreeForm_(contentBody, fields);
  }
  var activity = ar.activity, remark = ar.remark;

  if (!activity || activity.length < PARSER_CONFIG.minActivityLength) {
    if (photos > 0) return { _photoOnly: true, photos: photos, date: date };
    return null;
  }

  return {
    source: source,
    date: date,
    // No area match -> the General bucket, so nothing is lost.
    area: (area || PARSER_CONFIG.defaultArea).trim(),
    activity: activity.trim(),
    remark: remark.trim(),
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

/**
 * Return the canonical section name whose alias appears in the free text, or ''
 * if none. Aliases are matched with word-ish boundaries so "zone b" does not
 * match inside another word. First area in CONFIG.areas wins.
 */
function canonicalArea_(body) {
  var text = ' ' + String(body).toLowerCase() + ' ';
  for (var i = 0; i < PARSER_CONFIG.areas.length; i++) {
    var area = PARSER_CONFIG.areas[i];
    for (var a = 0; a < area.aliases.length; a++) {
      var alias = String(area.aliases[a]).toLowerCase();
      var re = new RegExp('(^|[^a-z0-9])' + escapeRe_(alias) + '([^a-z0-9]|$)', 'i');
      if (re.test(text)) return area.name;
    }
  }
  return '';
}

/** Canonicalise a labelled Area: value; keep the raw value if it is unknown. */
function canonicalizeAreaValue_(value) {
  return canonicalArea_(value) || String(value || '').trim();
}

/** True when the free text carries a site-activity signal (keyword or a number). */
function hasActivitySignal_(body) {
  // A standalone quantity like "25 m3" or "80%" — but NOT digits embedded in a
  // token such as the project code "N106", which would flag greetings.
  if (/(^|[^a-z0-9])\d+(\.\d+)?/i.test(body)) return true;
  var low = String(body).toLowerCase();
  for (var i = 0; i < PARSER_CONFIG.activityKeywords.length; i++) {
    if (low.indexOf(String(PARSER_CONFIG.activityKeywords[i]).toLowerCase()) !== -1) return true;
  }
  return false;
}

/** True when the message looks like greeting/ack chatter. */
function isChatter_(body) {
  for (var i = 0; i < PARSER_CONFIG.chatterPatterns.length; i++) {
    if (PARSER_CONFIG.chatterPatterns[i].test(body)) return true;
  }
  return false;
}

/**
 * Split a free-form body into activity (first non-empty line) + remark (the
 * rest). Labelled segments already captured elsewhere are removed first.
 */
function splitFreeForm_(body, fields) {
  var text = body;
  for (var key in fields) {
    if (fields[key]) text = text.split(fields[key]).join(' ');
  }
  var lines = text.split('\n').map(function (s) { return s.trim(); })
                  .filter(function (s) { return s.length > 0; });
  return { activity: lines[0] || '', remark: lines.slice(1).join(' | ') };
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
    canonicalArea_: canonicalArea_,
    hasActivitySignal_: hasActivitySignal_,
    normalizeDate_: normalizeDate_,
    PARSER_CONFIG: PARSER_CONFIG
  };
}
