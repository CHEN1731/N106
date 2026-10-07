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

  // The site's WhatsApp export locale, used to resolve AMBIGUOUS slash dates in the HEADER
  // timestamps (both fields <=12, e.g. "10/6/26"). 'mdy' = US month-first (this site), 'dmy' =
  // day-first, '' = auto-only (fall back to D/M/Y). A header with a field >12 (e.g. "9/25") is
  // auto-detected and overrides this; in-body hand-typed "Date:" values are NOT governed by it.
  dateOrder: 'mdy',

  // How finely the All-Activities list is broken up:
  //   'work'     = one row per DISTINCT work (site default, build-71). Same-work
  //                photo/progress repeats are still merged (mergeSameWork_), but
  //                different works at one location stay on SEPARATE rows so each
  //                sub-segment (e.g. the many small works inside XR14) is visible
  //                and can be pinpointed.
  //   'location' = ONE row per location/section within an area (all works at the
  //                same Sec-x/segment combined into a single activity; counts and
  //                manpower preserved from the combined text). Coarser overview.
  activityGranularity: 'work',

  // In-body field labels (case-insensitive). If present they win over
  // heuristics; label wording can be extended here.
  labels: {
    date: ['date'],
    area: ['area', 'section', 'location', 'zone'],
    activity: ['activity', 'work', 'task'],
    remark: ['remark', 'remarks', 'note', 'notes']
  },

  // === SITE LOCATOR (the main thing to tune) =========================
  // N106 messages start with a structured locator line, e.g.
  //   "Sec-C/ER15(Mb)"  or  "Sec-D/CCL/Ub/Base Slab/Kian Hup:"
  // The match key is Section (A-E) + segment code (the labels on the site plan:
  // Mb, Ub, Ld, Ta, ...). Both are read from the first non-empty line.
  locator: {
    // Section A-E, written "Sec-C", "Sec C", "Section C".
    sectionRe: /\bSec(?:tion)?[-\s]*([A-E])\b/i,
    // Segment / zone codes from the site plan. Matched as whole tokens in the
    // locator line (split on / ( ) space). Add/trim to match your plan labels.
    // Multi-letter names are listed before single letters so they win.
    segments: [
      'Portal', 'Cube8', 'SLF', 'SJII', 'TLQ', 'OPA', 'SPC', 'SOD', 'PIE', 'Sec-N',
      'Wc', 'Wb', 'Wa', 'Lc', 'Lb3', 'Lb2', 'Lb1', 'La3', 'La2', 'La1',
      'Le', 'Ld', 'Mb', 'Ma', 'P5', 'FB', 'Ja', 'Jb', 'Ka', 'Kb',
      'Qa', 'Qb', 'Qc', 'Qd', 'Sa', 'Sb', 'Ta', 'Tb', 'Tc', 'Ua', 'Ub',
      'N', 'P', 'R'
    ],
    // Regex patterns that recognise structure / pile / shaft codes as segments
    // without enumerating thousands of them (e.g. P323, DW1072, EI12, BT29-1,
    // MH02, NMH01, T9-3, CW319). A token matching any of these becomes the
    // segment. These carry no Area mapping (areaGroup stays '') unless also in
    // segmentArea. Tune to your real structure numbering.
    segmentPatterns: [
      /^P\d{2,4}$/i, /^DW\d{2,4}$/i, /^EI\d{1,3}$/i, /^BT\d{1,2}(?:-\d)?$/i,
      /^N?MH\d{1,3}$/i, /^T\d{1,2}-\d$/i, /^CW\d{2,4}$/i, /^BP-T\d/i,
      /^XR\d{1,3}$/i, /^ER\d{1,3}$/i, /^Cube\s?\d+$/i
    ],
    // Map each segment to its Area group (1-4) for the dashboard's higher-level
    // filter. From the N106 site plan; unmapped segments -> areaGroup ''.
    segmentArea: {
      // Area 1  ('SPC'/CM is always Sec-A /SPC/CM (Ja/Jb) in the data -> Area 1)
      'Ja': 'Area 1', 'Jb': 'Area 1', 'Ka': 'Area 1', 'Kb': 'Area 1',
      'Qa': 'Area 1', 'Qb': 'Area 1', 'SPC': 'Area 1',
      // Area 2  ('N'/Sec-N = the BTC canal / L&R-shaft / main-tunnel works;
      // 'PIE' = the "Under PIE CM / NB / Slip Rd" works — all Area 2 per site decision)
      'N': 'Area 2', 'Sec-N': 'Area 2', 'PIE': 'Area 2',
      'P': 'Area 2', 'Qc': 'Area 2', 'Qd': 'Area 2', 'R': 'Area 2', 'Sa': 'Area 2',
      'Ma': 'Area 2', 'Mb': 'Area 2', 'Ld': 'Area 2', 'Le': 'Area 2', 'Wb': 'Area 2',
      // Area 3
      'Sb': 'Area 3', 'Ta': 'Area 3', 'Tb': 'Area 3', 'Tc': 'Area 3',
      'Ua': 'Area 3', 'Ub': 'Area 3', 'Wa': 'Area 3',
      // Area 4
      'La1': 'Area 4', 'La2': 'Area 4', 'La3': 'Area 4', 'Lb1': 'Area 4', 'Lb2': 'Area 4',
      'Lb3': 'Area 4', 'P5': 'Area 4', 'Lc': 'Area 4', 'Wc': 'Area 4', 'FB': 'Area 4',
      // Named location codes (not lettered segments)
      'OPA': 'Area 2', 'SOD': 'Area 3', 'EI12': 'Area 3', 'XR14': 'Area 4', 'ER15': 'Area 2'
    },
    // Section-letter -> Area, for records that carry only a Section (Sec-A..Sec-E)
    // and no finer segment code. Used as a fallback after the segment map.
    sectionArea: {
      'A': 'Area 1',
      'B': 'Area 2', 'C': 'Area 2',
      'D': 'Area 3',
      'E': 'Area 4'
    },
    // Sub-contractor / crew names. A short line that is one of these is treated as a
    // SUB-SECTION header: the work under it is one activity, and different sub-contractors
    // in the same message become separate activities. Bullets / measurements under one
    // heading are NOT separate activities. Extend to your crews.
    subcontractors: [
      'SCT', 'MSK', 'HTC', 'CGW', 'CHCI', 'Huationg', 'Hua Tiong', 'Kori', 'Sambo',
      'Taehwa', 'Geosmart', 'Samsung', 'Kian Hup', 'Karh Lee'
    ]
  },

  // Optional generic area aliases, used only if no Section/segment is found
  // (kept for non-N106 reuse). Same shape as before: { name, aliases:[...] }.
  areas: [],

  // Fallback area for a message that has real site content but no locator match.
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
    /^\s*(hi|hello|hey|thanks?|thank you|tq|ok(ay)?|noted|received|well\s*done|welcome|sure|yes|no|copy|roger)\b[\s.!👍🙏]*$/i,
    /daily report (starting|start)/i,
    /site log\s*$/i,
    /^\s*[\p{Emoji}\s]+$/u,     // emoji-only messages
    /\?\s*$/                     // questions (RFI / coordination) end with "?"
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
    // Bracket-aware so the WHOLE "<… omitted>" / "<album message>" marker is removed — no
    // stray "<>" left to leak into the activity text or break locator resolution.
    /<?\s*media omitted\s*>?/i,
    /<album message>/i,
    /<?\s*image omitted\s*>?/i,
    /<?\s*photo omitted\s*>?/i,
    /<?\s*video omitted\s*>?/i,
    /\.(jpg|jpeg|png|heic|webp)\b/i
  ],

  // A message only becomes a record if it carries site content of this length.
  minActivityLength: 3,

  // Free-form mode (default). When false, a message must contain a recognised
  // label (Date:/Area:/Activity:/Remark:) to count — use only if your exports
  // are strictly a labelled template. Labelled fields are always honored when
  // present, so free-form mode still parses labelled messages correctly.
  requireLabelledRecord: false,

  // Keep ONLY messages that resolve to a real Section/segment locator (or a
  // labelled Area:). Daily site reports always carry one; greetings, questions
  // and coordination chatter do not — so this drops that noise instead of
  // letting it land in the General bucket. Set false to keep General records.
  requireLocator: true
};
// === END CONFIG =====================================================

/** Normalise newlines and strip WhatsApp's bidi/zero-width marks -> line array. */
function chatLines_(text) {
  return String(text)
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    // LRM/RLM, ZWSP, bidi embeddings, BOM — inserted before headers/media lines.
    .replace(/[​‎‏‪-‮﻿]/g, '')
    .split('\n');
}

/**
 * Keep only the chat messages whose header date is in `dates` (array of ISO
 * yyyy-mm-dd). Used to scope a full-history WhatsApp export down to one day
 * before extraction/comparison. Returns the sliced raw text (unknown formats or
 * empty `dates` return the input unchanged).
 */
function sliceChatByDate_(text, dates) {
  if (!text || !dates || !dates.length) return text;
  var want = {};
  dates.forEach(function (d) { want[String(d)] = true; });
  var lines = chatLines_(text);
  var format = detectFormat_(lines);
  var order = resolveDateOrder_(lines, dates[0]);   // use the ISO target to disambiguate M/D vs D/M
  var out = [], keep = false, any = false;
  for (var i = 0; i < lines.length; i++) {
    var m = format.re.exec(lines[i]);
    if (m) { keep = !!want[normalizeDate_(m[1], order)]; if (keep) any = true; }
    if (keep) out.push(lines[i]);
  }
  return any ? out.join('\n') : text; // no header matched -> don't lose the data
}

/** Keep only records whose date is in `dates` (array of ISO yyyy-mm-dd). */
function filterByDates_(records, dates) {
  if (!dates || !dates.length) return records;
  var want = {};
  dates.forEach(function (d) { want[String(d)] = true; });
  return records.filter(function (r) { return want[String(r.date)]; });
}

/**
 * Parse a raw export into an array of message objects.
 * @param {string} text  raw WhatsApp .txt contents
 * @param {string} source  'RTO' or 'Samsung'
 * @return {Array<Object>} records
 */
function parseWhatsApp(text, source, order) {
  if (!text) return [];
  var lines = chatLines_(text);
  var format = detectFormat_(lines);
  if (!order) order = resolveDateOrder_(lines);   // caller may pass a resolved order; else use the site default
  var messages = groupIntoMessages_(lines, format);
  var records = [];
  // Carry-forward locator: a short update with no Sec-x header inherits the most recent
  // stated location (reset implicitly as each located message updates it).
  var carry = { area: '', areaGroup: '', section: '', segment: '' };
  for (var i = 0; i < messages.length; i++) {
    var rec = messageToRecord_(messages[i], source, order, carry);
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
        // WhatsApp prefixes group-chat senders with "~ "; drop it.
        sender: m[3].trim().replace(/^~\s*/, ''),
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
/** Resolve the Area for a grouting report's LOCATION token (QC1/QD4/Section-R -> Area 2,
 * Ka1b -> Area 1, "… Area-2 …" -> Area 2). Reuses areaFromSection_; falls back to the alpha
 * base of a "Ka1b"/"Ma2a"-style code. Returns '' if unknown. */
function groutingArea_(loc) {
  var s = String(loc == null ? '' : loc).trim();
  if (!s) return '';
  var am = /\barea[\s\-]*([1-4])\b/i.exec(s);
  if (am) return 'Area ' + am[1];
  if (/\bTTMT\b/i.test(s)) return 'Area 1';   // Cube8-TTMT CM is the Sec-A (Area 1) works
  var a = typeof areaFromSection_ === 'function' ? areaFromSection_(s) : '';
  if (a) return a;
  // "Ka1b" / "Ma2a" -> try the leading-letters base (Ka / Ma)
  var base = /([A-Za-z]{1,3})\d/.exec(s);
  if (base && typeof areaFromSection_ === 'function') return areaFromSection_(base[1]) || '';
  return '';
}

/** Build ONE clean record from a TAM/base grouting survey report: strip the project/company
 * banner, keep the work (location + BH/DW id + grouting + depth), classify by LOCATION. */
function groutingRecord_(body, source, date, photos) {
  var lines = String(body).split(/\n/).map(function (l) { return l.replace(/[​-‏⁠﻿]/g, '').trim(); }).filter(Boolean);
  var locM = /location\s*[:\-]?\s*(.+)/i.exec(body);
  var loc = locM ? String(locM[1]).split(/\n/)[0].replace(/[()]/g, ' ').trim() : '';
  var areaGroup = groutingArea_(loc);
  // Keep the real work lines; drop the project banner, the bare company header and the forward meta.
  var work = lines.filter(function (l) {
    if (/^north\s+south\s+corridor\b/i.test(l)) return false;
    if (/^taehwa\b.*\bgeo\b/i.test(l) || /\bgeo\s*engr?\s*$/i.test(l)) return false;
    if (/^\((?:night|day)\s*shift\)/i.test(l) || /^date\s*[:\-]/i.test(l)) return false;
    return true;
  });
  var activity = work.join(' · ').replace(/\s{2,}/g, ' ').trim();
  if (!activity) return null;
  return {
    source: source, date: date,
    area: (loc || 'Grouting').replace(/\s+/g, ' ').trim(),
    areaGroup: (areaGroup || '').trim(),
    section: (loc || '').trim(), segment: '',
    activity: activity, activityItems: [activity], remark: '',
    photos: photos || 0, sender: '', rawTs: ''
  };
}

function messageToRecord_(msg, source, order, carry) {
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
    if (photos > 0) return { _photoOnly: true, photos: photos, date: normalizeDate_(msg.rawDate, order) };
    return null;
  }

  // The WhatsApp header timestamp follows the exporting phone's locale, so apply
  // the file-detected order to it. A human-typed in-body "Date:" follows the
  // reporter's own convention, so auto-detect that per value instead of forcing
  // the file order (a forwarded "25/9" must not become month 25 in an mdy file).
  var date = fields.date ? normalizeDate_(fields.date) : normalizeDate_(msg.rawDate, order);

  // Special-case: TAM / base grouting survey reports (TAEHWA GEO / Geosmart template). These use a
  // rigid "LOCATION:/BH NO:/Dia:/GL:/Depth:" layout that the generic locator/label logic shreds
  // (the work vanishes). Keep the whole report as ONE activity, classified by its LOCATION.
  if (/\bgrouting\s+work\b/i.test(contentBody) &&
      /\b(geo\s*engr?|taehwa|geosmart|bh\s*no|tam\b|improvement\s+length)\b/i.test(contentBody)) {
    var gr = groutingRecord_(contentBody, source, date, photos);
    if (gr) return gr;
  }


  // Resolve the site locator (Section + segment) from the first line. A labelled
  // Area: still wins if present; the generic alias list is a last resort.
  var loc = resolveLocator_(contentBody);
  var area = fields.area !== undefined
    ? canonicalizeAreaValue_(fields.area)
    : (loc.area || canonicalArea_(contentBody));

  // Locator-only mode: keep just real site reports (Section/segment or a
  // labelled Area:); drop greetings, questions and coordination chatter.
  // A REAL location maps to a known Area (non-empty areaGroup) or is a labelled Area:.
  // A bare element line like "DW05 concrete casting" resolves to area="DW05" with an
  // empty areaGroup — that's NOT a location, so it must not corrupt the carry nor strip
  // its own line; it is carried forward to the most recent real location instead.
  var hasRealLocator = fields.area !== undefined || !!loc.section || !!loc.areaGroup;
  var hasLocator;
  if (hasRealLocator) {
    // This message states its own location -> remember it so later location-less
    // activity lines can inherit it (carry-forward).
    if (carry) {
      carry.area = (area || loc.area || '').trim();
      carry.areaGroup = (loc.areaGroup || '').trim();
      carry.section = (loc.section || '').trim();
      carry.segment = (loc.segment || '').trim();
    }
    hasLocator = true;
  } else if (carry && carry.area && hasActivitySignal_(contentBody) && !isChatter_(contentBody)) {
    // A short update with no real location header but genuine work -> attach it to the most
    // recent location (what the AI used to do via context). locatorLine '' keeps every body line.
    loc = { area: carry.area, areaGroup: carry.areaGroup, section: carry.section,
            segment: carry.segment, locatorLine: '' };
    area = carry.area;
    hasLocator = true;
  } else {
    // No carry context: fall back to the original rule (a weak/element-only token still
    // keeps the record under Others; pure chatter is dropped by requireLocator below).
    hasLocator = !!loc.area;
  }
  if (PARSER_CONFIG.requireLocator && !hasLocator) {
    if (photos > 0) return { _photoOnly: true, photos: photos, date: date };
    return null;
  }

  // Does this message look like a site record at all?
  var hasSignal = !!loc.area || hasActivitySignal_(contentBody);
  var isCandidate = hasLabel || !!area || hasSignal;
  if (!isCandidate || (isChatter_(contentBody) && !area && !hasSignal)) {
    if (photos > 0) return { _photoOnly: true, photos: photos, date: date };
    return null;
  }

  // Build activity/remark. Labelled fields win; else use the description lines,
  // dropping the locator line (Sec-.../segment) which is not activity text.
  var ar;
  if (fields.activity !== undefined || fields.remark !== undefined) {
    ar = { activity: fields.activity || '', remark: fields.remark || '' };
    if (!ar.activity) ar = splitDescription_(contentBody, fields, loc.locatorLine);
  } else {
    ar = splitDescription_(contentBody, fields, loc.locatorLine);
  }
  var activity = ar.activity, remark = ar.remark;

  if (!activity || activity.length < PARSER_CONFIG.minActivityLength) {
    if (photos > 0) return { _photoOnly: true, photos: photos, date: date };
    return null;
  }

  // Distinct work-items packed into this one message (a bulleted/numbered list);
  // a single-element array when it is a single activity. Kept alongside the joined
  // `activity` so the dashboard can list each item without collapsing them, while
  // Compare / Raw_Logs keep using the joined `activity`.
  var items = (ar.items && ar.items.length) ? ar.items : [activity.trim()];

  return {
    source: source,
    date: date,
    // No locator match -> the General bucket, so nothing is lost.
    // Collapse whitespace so a labelled/multi-line value can't become a garbage key.
    area: (area || PARSER_CONFIG.defaultArea).replace(/\s+/g, ' ').trim(),
    areaGroup: (loc.areaGroup || '').trim(),
    section: (loc.section || '').trim(),
    segment: (loc.segment || '').trim(),
    activity: activity.trim(),
    activityItems: items,
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
  out = out.replace(/<\s*>/g, ' ');   // clean any residual empty brackets from a media marker
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
 * Resolve the site locator from a message: Section (A-E) + segment code, read
 * from the first non-empty line (the "Sec-C/ER15(Mb)" style header). Returns
 * { section, segment, area, areaGroup, locatorLine }; area is "" if none found.
 */
function resolveLocator_(body) {
  var lines = String(body).split('\n')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
  var out = { section: '', segment: '', area: '', areaGroup: '', locatorLine: '' };
  if (!lines.length) return out;

  var cfg = PARSER_CONFIG.locator || {};

  // Prefer the first line that actually carries a Section or segment token.
  for (var i = 0; i < lines.length && i < 3; i++) {
    var line = lines[i];
    var sec = cfg.sectionRe ? cfg.sectionRe.exec(line) : null;
    var seg = matchSegment_(line, cfg.segments || []);
    if (sec || seg) {
      out.section = sec ? ('Sec-' + sec[1].toUpperCase()) : '';
      out.segment = seg || '';
      out.locatorLine = line;
      break;
    }
  }

  if (out.section && out.segment) out.area = out.section + '/' + out.segment;
  else out.area = out.section || out.segment || '';

  if (out.segment && cfg.segmentArea && cfg.segmentArea[out.segment]) {
    out.areaGroup = cfg.segmentArea[out.segment];
  }
  return out;
}

/** First segment code appearing as a whole token in the line, or ''. */
function matchSegment_(line, segments) {
  // Tokens are delimited by / ( ) . , ; : space and similar. The "." matters for
  // glued headers like "AREA-4.XR14 -FB", which must expose the XR14 segment.
  var tokens = String(line).split(/[\/()\[\].,;:\s]+/).filter(Boolean);
  var byLower = {};
  for (var s = 0; s < segments.length; s++) byLower[String(segments[s]).toLowerCase()] = segments[s];
  var patterns = (PARSER_CONFIG.locator && PARSER_CONFIG.locator.segmentPatterns) || [];
  for (var t = 0; t < tokens.length; t++) {
    var hit = byLower[tokens[t].toLowerCase()];
    if (hit) return hit;
    for (var p = 0; p < patterns.length; p++) {
      if (patterns[p].test(tokens[t])) return tokens[t];  // structure/pile code
    }
  }
  return '';
}

/**
 * Build activity/remark from the description lines, dropping the locator line
 * and any labelled segments already captured. Everything else becomes the
 * activity text (kept together for reliable similarity matching); remark holds
 * any trailing manpower/note line.
 */
function splitDescription_(body, fields, locatorLine) {
  var text = body;
  for (var key in fields) {
    if (fields[key]) text = text.split(fields[key]).join(' ');
  }
  var lines = text.split('\n').map(function (s) { return s.trim(); })
                  .filter(function (s) { return s.length > 0; });
  if (locatorLine) {
    lines = lines.filter(function (l) { return l !== locatorLine; });
  }
  if (!lines.length) return { activity: '', remark: '', items: [] };
  // Pull a manpower line into remark; the rest is the activity description.
  var remarkLines = [], actLines = [];
  lines.forEach(function (l) {
    if (/manpower/i.test(l)) remarkLines.push(l); else actLines.push(l);
  });
  return {
    activity: actLines.join(' ').replace(/\s+/g, ' ').trim(),
    remark: remarkLines.join(' | ').trim(),
    // Distinct work-items when the description is a bulleted/numbered list (else one item).
    items: splitActivityItems_(actLines)
  };
}

/** True when a line begins with a list marker (-, *, •, ·, ▪, ◦, or "1." / "1)"). */
function isListMarker_(line) {
  return /^\s*(?:[-*•·▪◦]\s+|\d{1,2}[.)]\s+)/.test(String(line));
}

/** Strip a leading list marker from a line. */
function stripListMarker_(line) {
  return String(line).replace(/^\s*(?:[-*•·▪◦]\s+|\d{1,2}[.)]\s+)/, '').trim();
}

/**
 * True when a line is a forward's banner / section header rather than activity
 * content — a date, a shift/section label, or a manpower/machinery heading. Used
 * only to keep such lines out of the FIRST activity's text when splitting a list.
 */
function isHeaderNoise_(line) {
  var s = String(line).replace(/[​-‏⁠﻿]/g, '').trim();
  if (!s) return true;
  if (/^[^A-Za-z0-9]+$/.test(s)) return true;                          // pure decoration (💠 ※ ﹌)
  if (/^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(s)) return true;    // a bare date
  if (/^(day|night)\s*shift\b/i.test(s)) return true;
  if (/\bactivit(?:y|ies)\b\s*:?\s*$/i.test(s)) return true;          // "…ACTIVITIES" / "Activity"
  if (/^(activities|activity|machinery|equipments?|manpower)\b\s*[:\-]?\s*\d*\s*$/i.test(s)) return true;
  if (/^(forwarded|daily\s+manpower)\b/i.test(s)) return true;
  if (/\bcontractor\b\s*$/i.test(s)) return true;                     // "Huationg Contractor"
  if (/\bmanpower\b\s*[:\-]?\s*\d*\s*$/i.test(s)) return true;        // "Day shift Manpower", "Manpower : 19"
  if (/^area[\s.\-]*[1-4]\b/i.test(s)) return true;                   // an "AREA-4 …" banner
  if (/^samsung\b/i.test(s)) return true;                            // "SAMSUNG C&T N106" banner
  if (/^north\s+south\s+corridor\b/i.test(s)) return true;           // "NORTH SOUTH CORRIDOR(N106)" project banner
  if (/^taehwa\b.*\bgeo\b.*\blocation\s*[:\-]?\s*$/i.test(s)) return true;  // bare "TAEHWA GEO ENGR LOCATION:" (no work after)
  if (/^(contractor|time|weather|shift|date)\s*[:\-]/i.test(s)) return true;  // report-metadata headers
  if (/^[A-Za-z][A-Za-z .()\/&\-]*=\s*\d{1,3}\b/.test(s)) return true;  // roster "Site Supervisor (RES) = 01" (=, not :, to spare "level: 2.3m")
  return false;
}

/**
 * True when a line is a short header / label rather than activity content — a
 * sub-contractor tag or cell header ("HTC", "SCT", "North Cell"). Such a line
 * describes the NEXT work item, so it must attach to the following activity, not
 * be glued onto the previous one. Kept narrow (few words, no digit, not a
 * sentence) so real one-line activities are treated as content.
 */
function isHeaderLabel_(line) {
  var s = String(line).replace(/\s+/g, ' ').trim();
  if (!s) return false;
  return s.split(' ').length <= 4 && !/\d/.test(s) && !/[.!?]$/.test(s) && /^[A-Za-z]/.test(s);
}

/**
 * True when a line is a SUB-CONTRACTOR / crew header (SCT, MSK, Huationg, HTC …).
 * Such a line names the crew; the work under it is one activity, and different
 * sub-contractors in the same message become separate activities. A header is a
 * SHORT line (<= 4 words) whose first token (before a space or "/") is a known
 * sub-contractor name. Bullet markers and zero-width chars are stripped first.
 */
function isSubcontractorHeader_(line) {
  var s = stripListMarker_(String(line)).replace(/[​-‏⁠﻿]/g, '').trim();
  if (!s) return false;
  if (s.split(/\s+/).length > 4) return false;           // a header is short; inline work is not
  var low = s.toLowerCase();
  var subs = (PARSER_CONFIG.locator && PARSER_CONFIG.locator.subcontractors) || [];
  for (var i = 0; i < subs.length; i++) {
    var sub = String(subs[i]).toLowerCase();
    if (low === sub || low.indexOf(sub + ' ') === 0 || low.indexOf(sub + '/') === 0 || low.indexOf(sub + ' /') === 0) return true;
  }
  return false;
}

/**
 * Collapse a message's activity lines into ONE work-item. A WhatsApp message is
 * a single activity: its heading, bullet lines, measurements, metrics AND any
 * sub-contractor sub-headers (SCT / Huationg / HTC …) all describe the one report
 * and are joined together — sub-contractor headers do NOT split the message
 * (user decision, build-69). Banner / date / roster-heading noise is dropped up
 * front. Returns a single-element array (empty only when nothing substantive
 * remains). `isSubcontractorHeader_` / PARSER_CONFIG.locator.subcontractors are
 * retained for config documentation but no longer drive any split.
 */
function splitActivityItems_(actLines) {
  var norm = function (s) { return String(s).replace(/\s+/g, ' ').trim(); };
  var strip = function (s) { return stripListMarker_(String(s)); };
  if (!actLines || !actLines.length) return [];
  // Drop banner / date / roster-heading noise first.
  var lines = [];
  for (var i = 0; i < actLines.length; i++) {
    if (!isHeaderNoise_(actLines[i]) && norm(actLines[i])) lines.push(actLines[i]);
  }
  if (!lines.length) return [];
  // The whole message is ONE activity (bullets + sub-contractor headers merged).
  return [norm(lines.map(strip).join(' '))].filter(Boolean);
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
 * Normalise a slash date to ISO yyyy-mm-dd. WhatsApp exports come in both
 * D/M/Y (most common here) and M/D/Y (US exports, e.g. "9/25/26"), so which
 * field is the day is genuinely ambiguous per value.
 *
 * @param {string} raw    the raw date (e.g. "9/25/26", "25/9/26", "2026-09-25")
 * @param {string} order  optional 'mdy' or 'dmy' detected from the whole file
 *                        (see detectDateOrder_). When omitted, auto-detect per
 *                        value from an out-of-range field.
 *
 * Resolution: an explicit `order` wins. Otherwise, if the 2nd field > 12 it
 * can only be a day ⇒ M/D/Y; if the 1st field > 12 ⇒ D/M/Y; if neither field
 * disambiguates, default to D/M/Y (so "5/8/26" stays 2026-08-05, preserving the
 * existing samples/tests). Already-ISO input (yyyy-mm-dd) is returned unchanged.
 */
function normalizeDate_(raw, order) {
  if (!raw) return '';
  var m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(raw);
  if (!m) return String(raw).trim();
  var a = parseInt(m[1], 10), b = parseInt(m[2], 10), y = m[3];
  var d, mo;
  if (order === 'mdy') { mo = a; d = b; }
  else if (order === 'dmy') { d = a; mo = b; }
  else if (b > 12 && a <= 12) { mo = a; d = b; }   // 2nd field can't be a month → M/D/Y
  else if (a > 12 && b <= 12) { d = a; mo = b; }   // 1st field can't be a month → D/M/Y
  else { d = a; mo = b; }                          // ambiguous → keep D/M/Y
  if (y.length === 2) y = '20' + y;
  return y + '-' + pad2_(mo) + '-' + pad2_(d);
}

/**
 * Inspect an export's header timestamps and decide the date field order.
 * Returns 'mdy' if any timestamp's 2nd field exceeds 12 (only a day can),
 * 'dmy' if any 1st field exceeds 12, else '' (ambiguous — caller defaults).
 * A file-wide order fixes even the ambiguous dates within that file.
 */
function detectDateOrder_(lines) {
  if (!lines || !lines.length) return '';
  var fmt = detectFormat_(lines);
  var sawMdy = false, sawDmy = false;
  for (var i = 0; i < lines.length; i++) {
    var m = fmt.re.exec(lines[i]);
    if (!m) continue;
    var dm = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(m[1]);
    if (!dm) continue;
    var a = parseInt(dm[1], 10), b = parseInt(dm[2], 10);
    if (b > 12 && a <= 12) sawMdy = true;
    else if (a > 12 && b <= 12) sawDmy = true;
  }
  if (sawMdy && !sawDmy) return 'mdy';
  if (sawDmy && !sawMdy) return 'dmy';
  return '';
}

/**
 * Resolve the date-field order for a file, using a known ISO target date to break ties.
 * An unambiguous file (a day > 12 somewhere) wins via detectDateOrder_. When the file is
 * ambiguous (every slash-date has both fields <= 12, e.g. a single day like "10/2/26"), the
 * caller's `targetIso` (the picker's report date, unambiguous yyyy-mm-dd) tells us the intended
 * day: if reading the file's dates as M/D/Y matches the target, the file is M/D/Y; if D/M/Y
 * matches, it's D/M/Y. Falls back to '' (caller keeps the D/M/Y default) when nothing resolves.
 */
function resolveDateOrder_(lines, targetIso) {
  var cfg = (PARSER_CONFIG && PARSER_CONFIG.dateOrder) || '';
  var order = detectDateOrder_(lines);
  if (order) return order;                                   // unambiguous file -> trust it
  if (!targetIso || !/^\d{4}-\d{2}-\d{2}$/.test(String(targetIso))) return cfg;
  if (!lines || !lines.length) return cfg;
  var fmt = detectFormat_(lines);
  for (var i = 0; i < lines.length; i++) {
    var m = fmt.re.exec(lines[i]);
    if (!m) continue;
    if (!/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.test(m[1])) continue;   // only slash dates are ambiguous
    if (normalizeDate_(m[1], 'mdy') === targetIso) return 'mdy';
    if (normalizeDate_(m[1], 'dmy') === targetIso) return 'dmy';
  }
  return cfg;                                                // ambiguous + no target -> site default
}

function pad2_(s) { s = String(s); return s.length < 2 ? '0' + s : s; }
function escapeRe_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Export for Node test harness (ignored by Apps Script).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseWhatsApp: parseWhatsApp,
    resolveLocator_: resolveLocator_,
    stripMedia_: stripMedia_,
    canonicalArea_: canonicalArea_,
    hasActivitySignal_: hasActivitySignal_,
    normalizeDate_: normalizeDate_,
    detectDateOrder_: detectDateOrder_,
    resolveDateOrder_: resolveDateOrder_,
    groutingArea_: groutingArea_,
    splitActivityItems_: splitActivityItems_,
    isSubcontractorHeader_: isSubcontractorHeader_,
    sliceChatByDate_: sliceChatByDate_,
    filterByDates_: filterByDates_,
    PARSER_CONFIG: PARSER_CONFIG
  };
}
