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

// System prompt (persona + strict filtering / grouping / merging / traceability
// rules). Kept as a stable string so it also caches well as a prompt prefix.
var PRODUCTIVITY_SYSTEM =
  'You are an expert Lead Site Engineer. Your task is to extract, group, and merge ' +
  'construction daily records for project N106. Apply these rules strictly before ' +
  'outputting the JSON.\n\n' +
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
  '- "Waiting for..." (unless it signifies a specific halt/delay)\n' +
  '- "Maintenance" (e.g., "crane maintenance" or "hose change", unless it stops production)\n\n' +
  '3. STRICT GROUPING BY AREA:\n' +
  'Group every kept activity under exactly one "areaName": "Area 1", "Area 2", "Area 3", ' +
  '"Area 4", or "Others" (only when it truly maps to no area). Derive the area from the ' +
  'section/segment code using the site-plan map given in the user message.\n\n' +
  '4. MERGING LOGIC:\n' +
  'If the RTO notes and AIS report mention the same element (e.g., "DW1547"), merge them ' +
  'into a single comprehensive activity object. Do not list "DW1547" twice.\n\n' +
  '5. TRACEABILITY (back-check):\n' +
  'For each activity, set "elementId" to the specific structural ID it concerns (DW1547, ' +
  'BP-T9-3, BT20-2, CW323 …) or null, and set "sourceEvidence" to the ORIGINAL verbatim ' +
  'snippet from the input that this activity was derived from, so management can verify it. ' +
  'Each area\'s kpiBreakdown lists (activeDWalls/BoredPiles/ButtressWalls/CrossWalls) must ' +
  'contain exactly the element IDs that appear in that area\'s activities, and each *Count ' +
  'must equal its list length, so the KPI numbers reconcile against the activity rows.\n\n' +
  '6. CONCRETE VOLUME (strict):\n' +
  '- Count ONLY concrete CASTING (casting/concreting/pour). "LSS material backfilling" and ' +
  'any backfilling is NOT concrete casting — exclude its volume entirely.\n' +
  '- A reading written as "X/Y m3" means Y is the panel\'s TOTAL and X is the CURRENT cast so ' +
  'far — use X (the number before the slash), never Y.\n' +
  '- Count each panel\'s casting ONCE. If the same panel/element is reported several times, ' +
  'use only the LATEST (highest cumulative) reading — e.g. if it reaches "100/100 m3", count ' +
  '100 for that panel, not the sum of the intermediate readings.\n' +
  '- concreteVolumeM3 per area = the sum of each panel\'s single (latest) current-cast value; ' +
  'grandTotals.totalConcreteVolumeM3 = the sum across areas. Keep the raw figure in ' +
  'sourceEvidence so it can be back-checked.';

/** Claude forced-tool: merge/dedupe + metrics. */
function callClaudeProductivity_(rtoText, aisText, key, dateHint) {
  var tool = {
    name: 'emit_productivity',
    description: 'Return merged daily activities and productivity metrics for project N106.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'report date, ISO yyyy-mm-dd' },
        areas: {
          type: 'array',
          description: 'one entry per Area worked on that day',
          items: {
            type: 'object',
            properties: {
              areaName: { type: 'string', description: 'exactly "Area 1", "Area 2", "Area 3", "Area 4", or "Others"' },
              kpiBreakdown: {
                type: 'object',
                properties: {
                  activeDWalls: { type: 'array', items: { type: 'string' }, description: 'Diaphragm Wall IDs in this area, e.g. DW1547, DW04' },
                  dWallCount: { type: 'integer' },
                  activeBoredPiles: { type: 'array', items: { type: 'string' }, description: 'Bored Pile IDs, e.g. BP-T9-3' },
                  bPileCount: { type: 'integer' },
                  activeButtressWalls: { type: 'array', items: { type: 'string' }, description: 'Buttress Wall IDs, e.g. BT20-2' },
                  bWallCount: { type: 'integer' },
                  activeCrossWalls: { type: 'array', items: { type: 'string' }, description: 'Cross Wall IDs, e.g. CW323' },
                  cWallCount: { type: 'integer' },
                  concreteVolumeM3: { type: 'number', description: 'concrete cast in THIS area (m3)' },
                  areaManpower: { type: 'integer', description: 'total manpower in THIS area' }
                },
                required: ['activeDWalls', 'dWallCount', 'activeBoredPiles', 'bPileCount',
                           'activeButtressWalls', 'bWallCount', 'activeCrossWalls', 'cWallCount',
                           'concreteVolumeM3', 'areaManpower']
              },
              activities: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    elementId: { type: 'string', description: 'the specific ID (DW/BP/BT/CW) if applicable, else ""' },
                    section: { type: 'string', description: 'section/segment/location, e.g. Sec-C/Mb' },
                    activityDescription: { type: 'string', description: 'the work description' },
                    manpower: { type: 'integer', description: 'manpower for this activity (0 if unknown)' },
                    sourceEvidence: { type: 'string', description: 'original verbatim snippet from the input, for back-checking' }
                  },
                  required: ['elementId', 'section', 'activityDescription', 'manpower', 'sourceEvidence']
                }
              }
            },
            required: ['areaName', 'kpiBreakdown', 'activities']
          }
        },
        grandTotals: {
          type: 'object',
          properties: {
            totalConcreteVolumeM3: { type: 'number' },
            totalManpower: { type: 'integer' }
          },
          required: ['totalConcreteVolumeM3', 'totalManpower']
        }
      },
      required: ['date', 'areas', 'grandTotals']
    }
  };

  var prompt =
    'Build a daily productivity dashboard for construction project N106 from two inputs: ' +
    '(A) RTO field notes and (B) the AIS Daily Report. Apply the INCLUSION, EXCLUSION, ' +
    'GROUPING, MERGING, and TRACEABILITY rules from your instructions strictly.\n\n' +
    'Group all kept, merged activities BY AREA. Output one entry in "areas" per area worked ' +
    'on, each with:\n' +
    '   - "areaName": exactly "Area 1".."Area 4" or "Others".\n' +
    '   - "activities": each = { elementId, section, activityDescription, manpower, sourceEvidence }.\n' +
    '   - "kpiBreakdown": the counts/ID-lists for THIS area (activeDWalls + dWallCount, ' +
    'activeBoredPiles + bPileCount, activeButtressWalls + bWallCount, activeCrossWalls + ' +
    'cWallCount), plus concreteVolumeM3 (m3 cast in this area) and areaManpower. Each ID list ' +
    'must contain exactly the element IDs present in this area\'s activities; each *Count = its ' +
    'list length. (BP includes pile refs like T9-3.)\n' +
    'Also return "grandTotals": { totalConcreteVolumeM3, totalManpower } across all areas.\n\n' +
    'Derive "areaName" from the section/segment code using this N106 site-plan map ' +
    '(the code determines the Area); use "Others" only when nothing matches:\n' +
    'By segment/location code:\n' + areaListText_() + '\n' +
    'By Section letter (when no finer code is present):\n' + sectionListText_() + '\n' +
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

/**
 * Coerce the AI's nested area response into the canonical shape. KPI id-lists,
 * counts and totals are RECOMPUTED from the activities (buildProductivityResult_)
 * so the KPI numbers always reconcile against the activity rows (back-check).
 */
function normalizeProductivity_(raw, dateHint, source) {
  raw = raw || {};
  function str(v) { return String(v == null ? '' : v).trim(); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  var acts = [];
  (Array.isArray(raw.areas) ? raw.areas : []).forEach(function (ar) {
    ar = ar || {};
    var area = normAreaName_(ar.areaName);
    (Array.isArray(ar.activities) ? ar.activities : []).forEach(function (a) {
      a = a || {};
      var section = str(a.section);
      var activity = str(a.activityDescription != null ? a.activityDescription : a.activity);
      var elementId = str(a.elementId) || firstElementId_(section + ' ' + activity);
      acts.push({
        area: area || areaFromSection_(section) || 'Others',
        section: section, elementId: elementId, activity: activity,
        manpower: num(a.manpower), sourceEvidence: str(a.sourceEvidence)
      });
    });
  });
  acts = acts.filter(function (a) { return a.activity; });
  var date = normalizeDate_(raw.date) || dateHint || str(raw.date);
  return buildProductivityResult_(date, acts, source || 'ai');
}

/** Normalise an area label to "Area 1".."Area 4" / "Others" / "" (unknown). */
function normAreaName_(v) {
  var s = String(v == null ? '' : v).trim();
  var m = /area\s*([1-4])/i.exec(s);
  if (m) return 'Area ' + m[1];
  if (/^others?$/i.test(s) || /unassigned|general/i.test(s)) return 'Others';
  return '';
}

/** Which structure family an element ID belongs to: 'DW' | 'BP' | 'BT' | 'CW' | ''. */
function classifyElement_(id) {
  var s = String(id == null ? '' : id).toUpperCase().replace(/\s+/g, '');
  if (/^DW/.test(s)) return 'DW';
  if (/^BT/.test(s)) return 'BT';
  if (/^CW/.test(s)) return 'CW';
  if (/^BP/.test(s) || /^T\d+-\d+$/.test(s)) return 'BP';
  return '';
}

/**
 * Build the canonical productivity result from a flat activity list. Groups by
 * area, derives each area's KPI id-lists/counts from the element IDs that appear
 * in that area's activities (so counts reconcile with the rows), sums concrete
 * (from activity + sourceEvidence text, or the AI hint) and manpower, and rolls
 * up grand totals. Also returns a flattened mergedActivities for the Sheet.
 */
function buildProductivityResult_(date, acts, source) {
  var ORDER = ['Area 1', 'Area 2', 'Area 3', 'Area 4', 'Others'];
  var byArea = {};
  acts.forEach(function (a) {
    a.area = normAreaName_(a.area) || areaFromSection_(a.section) || 'Others';
    (byArea[a.area] = byArea[a.area] || []).push(a);
  });
  var areas = Object.keys(byArea).sort(function (x, y) {
    var ix = ORDER.indexOf(x), iy = ORDER.indexOf(y);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  }).map(function (area) {
    var list = byArea[area];
    var dw = [], bp = [], bt = [], cw = [], manpower = 0, castByPanel = {};
    list.forEach(function (a) {
      var blob = (a.elementId || '') + ' ' + (a.activity || '') + ' ' + (a.sourceEvidence || '');
      matchAll_(blob, new RegExp(ELEMENT_RE.source, 'gi')).forEach(function (code) {
        var t = classifyElement_(code);
        if (t === 'DW') dw.push(code); else if (t === 'BP') bp.push(code);
        else if (t === 'BT') bt.push(code); else if (t === 'CW') cw.push(code);
      });
      // Concrete casting: per activity take max(activity, evidence) so a repeated
      // snippet isn't double-counted; then keep the highest per panel (count once).
      var vol = Math.max(castVolumeOf_(a.activity || ''), castVolumeOf_(a.sourceEvidence || ''));
      if (vol > 0) {
        var panel = String(a.elementId || '').toUpperCase().replace(/\s+/g, '') ||
          ('SEC:' + (a.section || '') + '|' + String(a.activity || '').slice(0, 24));
        castByPanel[panel] = Math.max(castByPanel[panel] || 0, vol);
      }
      manpower += Number(a.manpower) || 0;
    });
    dw = uniqCodes_(dw); bp = uniqCodes_(bp); bt = uniqCodes_(bt); cw = uniqCodes_(cw);
    var concrete = 0;
    Object.keys(castByPanel).forEach(function (p) { concrete += castByPanel[p]; });
    return {
      areaName: area,
      kpiBreakdown: {
        activeDWalls: dw, dWallCount: dw.length,
        activeBoredPiles: bp, bPileCount: bp.length,
        activeButtressWalls: bt, bWallCount: bt.length,
        activeCrossWalls: cw, cWallCount: cw.length,
        concreteVolumeM3: Math.round(concrete * 100) / 100, areaManpower: manpower
      },
      activities: list.map(function (a) {
        return { elementId: a.elementId || '', section: a.section || '',
          activity: a.activity || '', manpower: Number(a.manpower) || 0,
          sourceEvidence: a.sourceEvidence || '' };
      })
    };
  });

  var gdw = [], gbp = [], gbt = [], gcw = [], gConc = 0, gMan = 0;
  areas.forEach(function (ar) {
    var k = ar.kpiBreakdown;
    gdw = gdw.concat(k.activeDWalls); gbp = gbp.concat(k.activeBoredPiles);
    gbt = gbt.concat(k.activeButtressWalls); gcw = gcw.concat(k.activeCrossWalls);
    gConc += k.concreteVolumeM3; gMan += k.areaManpower;
  });
  gdw = uniqCodes_(gdw); gbp = uniqCodes_(gbp); gbt = uniqCodes_(gbt); gcw = uniqCodes_(gcw);

  return {
    date: date,
    areas: areas,
    grandTotals: { totalConcreteVolumeM3: Math.round(gConc * 100) / 100, totalManpower: gMan },
    mergedActivities: acts.map(function (a) {
      return { area: a.area, section: a.section || '', elementId: a.elementId || '',
        activity: a.activity || '', manpower: Number(a.manpower) || 0,
        sourceEvidence: a.sourceEvidence || '' };
    }),
    productivityData: {
      activeDWalls: gdw, dWallCount: gdw.length,
      activeBoredPiles: gbp, bPileCount: gbp.length,
      activeButtressWalls: gbt, bWallCount: gbt.length,
      activeCrossWalls: gcw, cWallCount: gcw.length,
      totalConcreteVolumeM3: Math.round(gConc * 100) / 100, totalManpower: gMan
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

  var seen = {}, acts = [];
  all.forEach(function (r) {
    var act = r.activity || '';
    var k = String((r.area || '') + '|' + act).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
    if (seen[k]) return;
    seen[k] = true;
    var evidence = (r.remark ? (act + ' — ' + r.remark) : act).trim();
    acts.push({
      area: r.areaGroup || areaFromSection_(r.area) || '',
      section: r.area || '',
      elementId: firstElementId_((r.area || '') + ' ' + act),
      activity: act,
      manpower: firstManpower_((r.remark || '') + ' ' + act),
      sourceEvidence: evidence
    });
  });
  acts = acts.filter(function (a) { return a.activity; });
  // KPI id-lists/counts, concrete and manpower are derived from the activities.
  return buildProductivityResult_(date, acts, 'fallback');
}

function matchAll_(text, re) { var m = String(text).match(re); return m || []; }

// Structural element codes, used to fill an activity's elementId from its text.
var ELEMENT_RE = /\b(?:DW[-\s]?\d+[A-Za-z]?|BP[-\s]?[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?|BT[-\s]?\d+(?:-\d+)?|CW[-\s]?\d+|T\d+-\d+)\b/i;
function firstElementId_(t) {
  var m = String(t == null ? '' : t).match(ELEMENT_RE);
  return m ? m[0].toUpperCase().replace(/\s+/g, '') : '';
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

/**
 * Concrete-CASTING volume from one text snippet, per the site rules:
 *  - LSS material backfilling is NOT concrete casting -> returns 0.
 *  - Progressive "X/Y m3" means X = current cast, Y = panel total -> use X.
 *  - Otherwise only counts a plain "N m3" when the text is a casting context
 *    (cast/casting/concreting/pour), so mixing/soil/backfill volumes are ignored.
 * Per-panel de-duplication (use the latest/highest per panel, count once) is done
 * by the caller.
 */
function castVolumeOf_(text) {
  var t = String(text == null ? '' : text);
  if (/\blss\b/i.test(t) || /back\s*fill/i.test(t)) return 0;   // backfilling is not casting
  var best = 0, m;
  var prog = /(\d+(?:\.\d+)?)\s*\/\s*\d+(?:\.\d+)?\s*(?:m3|m³|cum|cu\.?\s?m)(?![a-z0-9])/gi;
  while ((m = prog.exec(t)) !== null) best = Math.max(best, parseFloat(m[1])); // current cast = X
  if (best) return best;
  if (/\b(cast|concret|pour)/i.test(t)) return sumConcreteM3_(t);  // casting/concreting/poured…
  return 0;
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
    buildProductivityResult_: buildProductivityResult_,
    areaFromSection_: areaFromSection_,
    normAreaName_: normAreaName_,
    classifyElement_: classifyElement_,
    firstElementId_: firstElementId_,
    uniqCodes_: uniqCodes_,
    sumConcreteM3_: sumConcreteM3_,
    castVolumeOf_: castVolumeOf_
  };
}
