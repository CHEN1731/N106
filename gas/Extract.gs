/**
 * Extract.gs — turn raw WhatsApp text into clean records.
 *
 * Primary path: Claude (Anthropic Messages API) via UrlFetchApp — robust to the
 * messy, free-form site messages. Fallback: the deterministic regex parser in
 * Parser.gs, used whenever there is no API key or the API call fails, so the app
 * always works offline.
 *
 * Setup: Apps Script → Project Settings → Script properties:
 *   ANTHROPIC_API_KEY   (required to enable the AI path)
 *   CLAUDE_MODEL        (optional; defaults to claude-opus-5)
 */

var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * The single entry point the app uses. Returns records shaped exactly like
 * parseWhatsApp() (source, date, area, areaGroup, section, segment, activity,
 * remark, photos, sender, rawTs).
 */
function extractRecords(source, text) {
  var key = getApiKey_();
  if (key) {
    try {
      var recs = callClaude_(text, source, key);
      if (recs && recs.length) return recs;
      // Empty AI result on non-empty input -> fall back rather than lose data.
    } catch (err) {
      // Log and fall back to the offline parser.
      try { console.error('AI extraction failed, using parser: ' + err); } catch (e) {}
    }
  }
  return parseWhatsApp(text, source);
}

function getApiKey_() {
  try { return PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'); }
  catch (e) { return null; }
}

function getModel_() {
  try {
    return PropertiesService.getScriptProperties().getProperty('CLAUDE_MODEL') || DEFAULT_MODEL;
  } catch (e) { return DEFAULT_MODEL; }
}

/**
 * Call Claude to extract structured records. Uses a forced tool call so the
 * response is guaranteed-shape JSON (no prose to parse).
 */
function callClaude_(text, source, key) {
  var tool = {
    name: 'emit_records',
    description: 'Return the cleaned daily site records found in the chat export.',
    input_schema: {
      type: 'object',
      properties: {
        records: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'ISO yyyy-mm-dd' },
              section: { type: 'string', description: 'e.g. Sec-C (or empty)' },
              segment: { type: 'string', description: 'site-plan code e.g. Mb, Ub, Ld (or empty)' },
              activity: { type: 'string', description: 'full work description' },
              remark: { type: 'string', description: 'manpower / notes (or empty)' },
              photos: { type: 'integer', description: 'number of photos attached' }
            },
            required: ['date', 'section', 'segment', 'activity', 'remark', 'photos']
          }
        }
      },
      required: ['records']
    }
  };

  var instructions =
    'You extract daily construction site progress records for project N106. The ' +
    'input is EITHER a WhatsApp chat export (lines like "[5/8/26, 10:09] ~ Name: ...") ' +
    'OR a structured daily report document (blocks grouped under "AREA 1-4" headers, ' +
    'each with a location / contractor / activity / "Manpower - N"). Handle whichever ' +
    'you are given. A record\'s locator may be written many ways — "Sec-C/ER15(Mb)", ' +
    '"Sec D/SLF/...", "CUBE 8 ... (Qb)", "TMC (Sec.Ka)", "Sec N(N3a)". Rules:\n' +
    '- Return ONE record per distinct site report/location block. In a chat, fold a ' +
    'report\'s immediately-following photo messages into its "photos" count.\n' +
    '- "section": the Section letter as "Sec-X" (A-E) when present, else "".\n' +
    '- "segment": the site-plan segment/zone code when identifiable (Mb, Ub, Ld, Ta, ' +
    'Ka, Qb, Ja, Jb, N, P, R, Sa ...). If the location names a code not in that set ' +
    '(e.g. P323, EI12, DW1072, Cube8, Gate#28), put the most specific location token ' +
    'in "segment" anyway so it can be matched; leave "" only if truly none.\n' +
    '- "activity" = the full work description (keep complete, do not summarise).\n' +
    '- "remark" = manpower / equipment / trailing notes.\n' +
    '- IGNORE greetings, acknowledgements, emoji-only and coordination chatter.\n' +
    '- "date" = the report/message date as ISO yyyy-mm-dd (use the report header date ' +
    'for a document).\n' +
    'Call emit_records with every record you find.\n\n' +
    'INPUT:\n' + text;

  var body = {
    model: getModel_(),
    max_tokens: 8192,
    output_config: { effort: 'low' },
    tools: [tool],
    tool_choice: { type: 'tool', name: 'emit_records' },
    messages: [{ role: 'user', content: instructions }]
  };

  var resp = UrlFetchApp.fetch(ANTHROPIC_URL, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(body)
  });

  var code = resp.getResponseCode();
  var data = JSON.parse(resp.getContentText());
  if (code !== 200) {
    throw new Error('Anthropic ' + code + ': ' + (data && data.error && data.error.message));
  }

  var records = [];
  (data.content || []).forEach(function (block) {
    if (block.type === 'tool_use' && block.input && block.input.records) {
      records = block.input.records;
    }
  });

  return records.map(function (r) { return normalizeExtracted_(r, source); })
                .filter(function (r) { return r; });
}

/** Map a Claude record onto the canonical record shape used everywhere else. */
function normalizeExtracted_(r, source) {
  var activity = String(r.activity || '').trim();
  if (!activity) return null;
  var section = String(r.section || '').trim();
  var segment = String(r.segment || '').trim();
  var area = section && segment ? section + '/' + segment
           : (section || segment || PARSER_CONFIG.defaultArea);
  var areaGroup = '';
  var map = PARSER_CONFIG.locator && PARSER_CONFIG.locator.segmentArea;
  if (segment && map && map[segment]) areaGroup = map[segment];

  return {
    source: source,
    date: normalizeDate_(r.date) || String(r.date || '').trim(),
    area: area,
    areaGroup: areaGroup,
    section: section,
    segment: segment,
    activity: activity,
    remark: String(r.remark || '').trim(),
    photos: Number(r.photos) || 0,
    sender: '',
    rawTs: ''
  };
}

/* ======================================================================
 * AREA FILLING — derive the Area (1-4) from a section/segment code using the
 * N106 site-plan map (PARSER_CONFIG.locator.segmentArea), so records that are
 * missing their Area get it filled deterministically on every path.
 * ==================================================================== */

/** Lowercased segment -> "Area N" lookup (built from the single source map). */
function areaMapLower_() {
  var map = (PARSER_CONFIG.locator && PARSER_CONFIG.locator.segmentArea) || {};
  var lower = {};
  Object.keys(map).forEach(function (k) { lower[k.toLowerCase()] = map[k]; });
  return lower;
}

/** First whole token of `str` that is a known segment (longer tokens win: P5 before P). */
function scanTokens_(str, lower) {
  var tokens = String(str).split(/[^A-Za-z0-9]+/).filter(Boolean);
  tokens.sort(function (a, b) { return b.length - a.length; });
  for (var i = 0; i < tokens.length; i++) {
    var v = lower[tokens[i].toLowerCase()];
    if (v) return v;
  }
  return '';
}

/**
 * Return "Area 1".."Area 4" for a section/segment string, or "" if none maps.
 * Already-correct "Area N" input is kept. The segment after the last "/" is
 * tried first (e.g. "Sec-C/Mb" -> "Mb" -> Area 2), then the whole string.
 */
function areaFromSection_(section) {
  var s = String(section == null ? '' : section).trim();
  if (!s) return '';
  var am = /^area\s*([1-4])$/i.exec(s);
  if (am) return 'Area ' + am[1];
  var lower = areaMapLower_();
  var slash = s.lastIndexOf('/');
  var cand = slash >= 0 ? s.slice(slash + 1) : s;
  // 1) Prefer the finer segment/location code (Mb, Ub, OPA, EI12 ...).
  var hit = scanTokens_(cand, lower) || scanTokens_(s, lower);
  if (hit) return hit;
  // 2) Fall back to the Section letter (Sec-A .. Sec-E).
  var sec = /\bsec(?:tion)?[.\-\s]*([A-E])\b/i.exec(s);
  if (sec) {
    var map = (PARSER_CONFIG.locator && PARSER_CONFIG.locator.sectionArea) || {};
    return map[sec[1].toUpperCase()] || '';
  }
  return '';
}

/** The area->segments mapping as prompt text, e.g. "Area 1: Ja, Jb, ...". */
function areaListText_() {
  var map = (PARSER_CONFIG.locator && PARSER_CONFIG.locator.segmentArea) || {};
  var groups = {};
  Object.keys(map).forEach(function (k) { (groups[map[k]] = groups[map[k]] || []).push(k); });
  return Object.keys(groups).sort().map(function (g) { return g + ': ' + groups[g].join(', '); }).join('\n');
}

/** The Section-letter -> Area mapping as prompt text. */
function sectionListText_() {
  var map = (PARSER_CONFIG.locator && PARSER_CONFIG.locator.sectionArea) || {};
  var groups = {};
  Object.keys(map).forEach(function (k) { (groups[map[k]] = groups[map[k]] || []).push('Sec-' + k); });
  return Object.keys(groups).sort().map(function (g) { return g + ': ' + groups[g].join(', '); }).join('\n');
}

/* ======================================================================
 * PRODUCTIVITY & SUMMARY — merge + dedupe activities from RTO and AIS and
 * extract quantitative productivity metrics (DW / BP / BT / CW counts,
 * concrete m3, manpower). AI path (Claude) with a deterministic fallback.
 * ==================================================================== */

/**
 * @param {string} rtoText  RTO raw notes
 * @param {string} aisText  AIS Daily Report text
 * @param {string} dateHint ISO yyyy-mm-dd to scope to (optional)
 * @return {Object} { date, mergedActivities[], productivityData{}, source }
 */
function generateProductivity(rtoText, aisText, dateHint) {
  var key = getApiKey_();
  if (key) {
    try {
      var p = callClaudeProductivity_(rtoText, aisText, key, dateHint);
      if (p) return p;
    } catch (err) {
      try { console.error('AI productivity failed, using fallback: ' + err); } catch (e) {}
    }
  }
  return productivityFromRecords_(rtoText, aisText, dateHint);
}

// System prompt (persona + strict filtering/status/merging rules). Kept as a
// stable string so it also caches well as a prompt prefix.
var PRODUCTIVITY_SYSTEM =
  'You are an expert Lead Site Engineer. Your task is to extract and merge construction ' +
  'daily records. You must apply strict filtering rules before outputting the JSON.\n\n' +
  '1. INCLUSION RULES (What to Keep - High Value Data):\n' +
  'Extract activities that contain actual physical progress or critical path delays. Look ' +
  'for these positive keywords:\n' +
  '- Piling & Walls (DW, BP, BT, CW): "drilling", "excavation", "lowering" (e.g., rebar ' +
  'cages), "concreting", "casting", "grouting", "backfilling", "hacking".\n' +
  '- Metrics: Always extract any mention of volume ("m3", "m³"), depth ("m"), load counts ' +
  '("loads"), and "manpower".\n\n' +
  '2. EXCLUSION RULES (What to Ignore/Filter Out - Noise):\n' +
  'DO NOT extract or include activities if they are purely non-value-adding or ' +
  'administrative, UNLESS they block a critical path. Ignore entries with these negative ' +
  'keywords:\n' +
  '- "No activity" or "No Activity observed"\n' +
  '- "Housekeeping" or "Cleaning" (unless it is a specific major milestone)\n' +
  '- "Preparation work" (only extract if it involves physical installation like "platform setup")\n' +
  '- "Waiting for..." (unless it signifies a specific halt/delay status)\n' +
  '- "Maintenance" (e.g., "crane maintenance" or "hose change", unless it stops production)\n\n' +
  '3. STRICT STATUS CLASSIFICATION:\n' +
  'For the activities that pass the inclusion rules, strictly assign one of the following ' +
  'statuses:\n' +
  '- Completed: Only if words like "completed", "done", or "finished" are explicitly used.\n' +
  '- In Progress: For ongoing physical works ("ongoing", "in progress", "started").\n' +
  '- Halted/Delayed: If work stopped due to "breakdown", "leaking", "rejected", or "waiting for mechanic".\n\n' +
  '4. MERGING LOGIC:\n' +
  'If the RTO notes and AIS report mention the same element (e.g., "DW1547"), merge them ' +
  'into a single comprehensive activity object. Do not list "DW1547" twice.';

/** Claude forced-tool: merge/dedupe + metrics. */
function callClaudeProductivity_(rtoText, aisText, key, dateHint) {
  var tool = {
    name: 'emit_productivity',
    description: 'Return merged daily activities and productivity metrics for project N106.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'report date, ISO yyyy-mm-dd' },
        mergedActivities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              area: { type: 'string', description: 'Area 1-4 (or "")' },
              section: { type: 'string', description: 'Section/segment/location, e.g. Sec-C/Mb' },
              elementId: { type: 'string', description: 'structural element ID, e.g. DW1547, BP-T9-3, BT20-2, CW323 ("" if none)' },
              activity: { type: 'string', description: 'unified work description' },
              status: { type: 'string', description: 'Completed | In Progress | Halted/Delayed' },
              manpower: { type: 'integer', description: 'manpower for this activity (0 if unknown)' }
            },
            required: ['area', 'section', 'elementId', 'activity', 'status', 'manpower']
          }
        },
        productivityData: {
          type: 'object',
          properties: {
            activeDWalls: { type: 'array', items: { type: 'string' }, description: 'Diaphragm Wall IDs e.g. DW1547, DW04' },
            dWallCount: { type: 'integer' },
            activeBoredPiles: { type: 'array', items: { type: 'string' }, description: 'Bored Pile IDs e.g. BP-T9-3' },
            bPileCount: { type: 'integer' },
            activeButtressWalls: { type: 'array', items: { type: 'string' }, description: 'Buttress Wall IDs e.g. BT20-2' },
            bWallCount: { type: 'integer' },
            activeCrossWalls: { type: 'array', items: { type: 'string' }, description: 'Cross Wall IDs e.g. CW323' },
            cWallCount: { type: 'integer' },
            totalConcreteVolumeM3: { type: 'number', description: 'sum of concrete cast volumes in m3' },
            totalManpower: { type: 'integer', description: 'sum of all manpower reported (deduped)' }
          },
          required: ['activeDWalls', 'dWallCount', 'activeBoredPiles', 'bPileCount',
                     'activeButtressWalls', 'bWallCount', 'activeCrossWalls', 'cWallCount',
                     'totalConcreteVolumeM3', 'totalManpower']
        }
      },
      required: ['date', 'mergedActivities', 'productivityData']
    }
  };

  var prompt =
    'Build a daily productivity dashboard for construction project N106 from two inputs: ' +
    '(A) RTO field notes and (B) the AIS Daily Report. Apply the INCLUSION, EXCLUSION, ' +
    'STATUS, and MERGING rules from your instructions strictly.\n\n' +
    '1) For each activity that PASSES the inclusion/exclusion rules, output ONE merged, ' +
    'de-duplicated object with:\n' +
    '   - "area": Area 1-4 (see the site-plan map below).\n' +
    '   - "section": the section/segment/location, e.g. Sec-C/Mb.\n' +
    '   - "elementId": the structural element ID it concerns (DW1547, BP-T9-3, BT20-2, ' +
    'CW323 …), or "" if none.\n' +
    '   - "activity": the unified work description.\n' +
    '   - "status": exactly one of Completed | In Progress | Halted/Delayed (per the STATUS rules).\n' +
    '   - "manpower": manpower for this activity (0 if none).\n' +
    '   ALWAYS fill "area" — derive it from the section/segment code using this N106 ' +
    'site-plan map (the code determines the Area). Use exactly "Area 1".."Area 4"; leave ' +
    '"area" empty only if the section has no code from these lists:\n' +
    'By segment/location code:\n' + areaListText_() + '\n' +
    'By Section letter (when no finer code is present):\n' + sectionListText_() + '\n' +
    '2) EXTRACT productivity metrics across the merged day:\n' +
    '   - activeDWalls: all Diaphragm Wall IDs worked on (e.g. DW1547, DW04, DW-64).\n' +
    '   - activeBoredPiles: all Bored Pile IDs (e.g. BP-T9-3, and pile refs like T9-3).\n' +
    '   - activeButtressWalls: all Buttress Wall IDs (e.g. BT20-2, BT24-1).\n' +
    '   - activeCrossWalls: all Cross Wall IDs (e.g. CW323, CW320).\n' +
    '   Deduplicate each list; the *Count fields must equal each list\'s length.\n' +
    '   - totalConcreteVolumeM3: sum of every concrete cast volume in m3/m³.\n' +
    '   - totalManpower: sum of manpower across the merged (deduped) activities.\n' +
    (dateHint ? ('This report is for ' + dateHint + '. Only include work for that date.\n') : '') +
    'Call emit_productivity once.\n\n' +
    '=== RTO NOTES ===\n' + (rtoText || '(none)') +
    '\n\n=== AIS DAILY REPORT ===\n' + (aisText || '(none)');

  var body = {
    model: getModel_(),
    max_tokens: 8192,
    output_config: { effort: 'low' },
    system: PRODUCTIVITY_SYSTEM,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'emit_productivity' },
    messages: [{ role: 'user', content: prompt }]
  };

  var resp = UrlFetchApp.fetch(ANTHROPIC_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(body)
  });
  var code = resp.getResponseCode();
  var data = JSON.parse(resp.getContentText());
  if (code !== 200) throw new Error('Anthropic ' + code + ': ' + (data && data.error && data.error.message));

  var raw = null;
  (data.content || []).forEach(function (b) { if (b.type === 'tool_use' && b.input) raw = b.input; });
  if (!raw) throw new Error('No productivity data returned');
  return normalizeProductivity_(raw, dateHint, 'ai');
}

/** Coerce any productivity object into the canonical shape; recompute counts. */
function normalizeProductivity_(raw, dateHint, source) {
  raw = raw || {};
  var pd = raw.productivityData || {};
  function arr(v) { return Array.isArray(v) ? v : []; }
  function str(v) { return String(v == null ? '' : v).trim(); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  var dw = uniqCodes_(arr(pd.activeDWalls).map(str).filter(Boolean));
  var bp = uniqCodes_(arr(pd.activeBoredPiles).map(str).filter(Boolean));
  var bt = uniqCodes_(arr(pd.activeButtressWalls).map(str).filter(Boolean));
  var cw = uniqCodes_(arr(pd.activeCrossWalls).map(str).filter(Boolean));

  var merged = arr(raw.mergedActivities).map(function (a) {
    var section = str(a.section);
    // Deterministic site-plan map fills/corrects the Area from the section code;
    // fall back to whatever the AI put when the section has no mappable code.
    var area = areaFromSection_(section) || str(a.area);
    var activity = str(a.activity);
    var elementId = str(a.elementId) || firstElementId_(section + ' ' + activity);
    return { area: area, section: section, elementId: elementId, activity: activity,
             status: normActivityStatus_(a.status || activity), manpower: num(a.manpower) };
  }).filter(function (a) { return a.activity; });

  var totalManpower = num(pd.totalManpower);
  if (!totalManpower) totalManpower = merged.reduce(function (s, a) { return s + (a.manpower || 0); }, 0);

  return {
    date: normalizeDate_(raw.date) || dateHint || str(raw.date),
    mergedActivities: merged,
    productivityData: {
      activeDWalls: dw, dWallCount: dw.length,
      activeBoredPiles: bp, bPileCount: bp.length,
      activeButtressWalls: bt, bWallCount: bt.length,
      activeCrossWalls: cw, cWallCount: cw.length,
      totalConcreteVolumeM3: Math.round(num(pd.totalConcreteVolumeM3) * 100) / 100,
      totalManpower: totalManpower
    },
    source: source || 'ai'
  };
}

/**
 * Deterministic fallback (no AI): parse both texts, merge/dedupe activities, and
 * regex-extract DW/BP/BT/CW codes, concrete m3 and manpower.
 */
function productivityFromRecords_(rtoText, aisText, dateHint) {
  var rto = parseWhatsApp(rtoText, 'RTO');
  var ais = parseWhatsApp(aisText, 'AIS');
  if (dateHint) { rto = filterByDates_(rto, [dateHint]); ais = filterByDates_(ais, [dateHint]); }
  var all = rto.concat(ais);
  var date = dateHint || mostCommonDate_(all);

  var seen = {}, merged = [];
  all.forEach(function (r) {
    var k = String(r.area + '|' + r.activity).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
    if (seen[k]) return;
    seen[k] = true;
    var act = r.activity || '';
    merged.push({
      area: r.areaGroup || areaFromSection_(r.area) || '',
      section: r.area || '',
      elementId: firstElementId_((r.area || '') + ' ' + act),
      activity: act,
      status: normActivityStatus_((r.remark || '') + ' ' + act),
      manpower: firstManpower_((r.remark || '') + ' ' + act)
    });
  });

  var text = merged.map(function (m) { return m.section + ' ' + m.activity; }).join(' \n ');
  var dw = uniqCodes_(matchAll_(text, /\bDW[-\s]?\d+[A-Za-z]?\b/gi));
  var bp = uniqCodes_(matchAll_(text, /\bBP[-\s]?[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?\b/gi)
                       .concat(matchAll_(text, /\bT\d+-\d+\b/gi)));
  var bt = uniqCodes_(matchAll_(text, /\bBT[-\s]?\d+(?:-\d+)?\b/gi));
  var cw = uniqCodes_(matchAll_(text, /\bCW[-\s]?\d+\b/gi));
  var concrete = sumConcreteM3_(text);
  var manpower = merged.reduce(function (s, m) { return s + (m.manpower || 0); }, 0);

  return {
    date: date,
    mergedActivities: merged,
    productivityData: {
      activeDWalls: dw, dWallCount: dw.length,
      activeBoredPiles: bp, bPileCount: bp.length,
      activeButtressWalls: bt, bWallCount: bt.length,
      activeCrossWalls: cw, cWallCount: cw.length,
      totalConcreteVolumeM3: Math.round(concrete * 100) / 100,
      totalManpower: manpower
    },
    source: 'fallback'
  };
}

function matchAll_(text, re) { var m = String(text).match(re); return m || []; }

// Structural element codes, used to fill an activity's elementId from its text.
var ELEMENT_RE = /\b(?:DW[-\s]?\d+[A-Za-z]?|BP[-\s]?[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?|BT[-\s]?\d+(?:-\d+)?|CW[-\s]?\d+|T\d+-\d+)\b/i;
function firstElementId_(t) {
  var m = String(t == null ? '' : t).match(ELEMENT_RE);
  return m ? m[0].toUpperCase().replace(/\s+/g, '') : '';
}

/** Classify an activity's status: Completed | In Progress | Halted/Delayed (default In Progress). */
function normActivityStatus_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'completed' || s === 'in progress' || s === 'halted/delayed') {
    return s === 'in progress' ? 'In Progress' : (s === 'completed' ? 'Completed' : 'Halted/Delayed');
  }
  if (/\b(halt|delay|breakdown|broke\s?down|leak|rejected?|waiting for mechanic|stopped|standby|abort)/.test(s)) {
    return 'Halted/Delayed';
  }
  if (/\b(completed?|done|finished?)\b/.test(s)) return 'Completed';
  return 'In Progress';
}

/** Normalise a structural code and dedupe case-insensitively (keep first form). */
function uniqCodes_(list) {
  var seen = {}, out = [];
  list.forEach(function (c) {
    var norm = String(c).toUpperCase().replace(/\s+/g, '');
    if (!norm || seen[norm]) return;
    seen[norm] = true;
    out.push(norm);
  });
  return out;
}

function firstManpower_(t) {
  var m = /(\d+)\s*pax\b/i.exec(t) || /man\s*power[^0-9]{0,8}(\d+)/i.exec(t);
  return m ? parseInt(m[1], 10) : 0;
}

function sumConcreteM3_(t) {
  // Number followed by a concrete-volume unit; the (?![a-z0-9]) end-guard works
  // for "m³" (³ is not a \b word char, so \b would miss it).
  var re = /(\d+(?:\.\d+)?)\s*(?:m3|m³|cum|cu\.?\s?m)(?![a-z0-9])/gi, m, sum = 0;
  while ((m = re.exec(String(t))) !== null) sum += parseFloat(m[1]);
  return sum;
}

function mostCommonDate_(records) {
  var counts = {}, best = '', bestN = 0;
  records.forEach(function (r) {
    if (!r.date) return;
    counts[r.date] = (counts[r.date] || 0) + 1;
    if (counts[r.date] > bestN) { bestN = counts[r.date]; best = r.date; }
  });
  return best;
}

// Export for the Node test harness (ignored by Apps Script).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeExtracted_: normalizeExtracted_,
    generateProductivity: generateProductivity,
    normalizeProductivity_: normalizeProductivity_,
    productivityFromRecords_: productivityFromRecords_,
    areaFromSection_: areaFromSection_,
    normActivityStatus_: normActivityStatus_,
    firstElementId_: firstElementId_,
    uniqCodes_: uniqCodes_,
    sumConcreteM3_: sumConcreteM3_
  };
}
