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
  // Fallback: a segment written with a sub-number (Le2 -> Le, Ld1 -> Ld). Only strip trailing
  // digits when the alpha prefix is >= 2 chars, so "N106" never collapses to "N" (Area 1).
  for (var j = 0; j < tokens.length; j++) {
    var m = /^([A-Za-z]{2,})\d+$/.exec(tokens[j]);
    if (m) { var w = lower[m[1].toLowerCase()]; if (w) return w; }
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
  'Merge into ONE activity object ONLY when two lines describe the SAME element AND the same ' +
  'operation (e.g. RTO and AIS both report casting of "DW1547"). Do NOT over-merge: keep ' +
  'every DISTINCT work item as its own activity (a different element, panel, structure type, ' +
  'or operation is a separate entry), and never drop an activity that passed the inclusion ' +
  'rules. Listing fewer activities than there are distinct work items is an error.\n\n' +
  '5. TRACEABILITY (back-check):\n' +
  'For each activity, set "elementId" to the specific structural ID it concerns (DW1547, ' +
  'BP-T9-3, BT20-2, CW323 …) or "". Each area\'s kpiBreakdown lists ' +
  '(activeDWalls/BoredPiles/ButtressWalls/CrossWalls) must contain exactly the element IDs ' +
  'that appear in that area\'s activities, and each *Count must equal its list length, so the ' +
  'KPI numbers reconcile against the activity rows.\n\n' +
  '6. CONCRETE VOLUME (strict):\n' +
  '- Count ONLY concrete CASTING (casting/concreting/pour). "LSS material backfilling" and ' +
  'any backfilling is NOT concrete casting — exclude its volume. If an activity mentions BOTH ' +
  'a casting figure and LSS/backfilling (e.g. "concrete casting 54/54 m3 + LSS backfilling"), ' +
  'count ONLY the casting figure (54) and ignore the backfilling.\n' +
  '- A reading written as "X/Y m3" means Y is the panel\'s TOTAL and X is the CURRENT cast so ' +
  'far — use X (the number before the slash), never Y.\n' +
  '- Count each panel\'s casting ONCE. If the same panel/element is reported several times, ' +
  'use only the LATEST (highest cumulative) reading — e.g. if it reaches "100/100 m3", count ' +
  '100 for that panel, not the sum of the intermediate readings.\n' +
  '- Keep the volume figure inside "activityDescription" so it can be back-checked.\n\n' +
  '7. CONSTRUCTION STAGE:\n' +
  'Classify each activity into exactly one "stage" — the FURTHEST construction step the ' +
  'element has reached: "Guide Wall", "Excavation", "Rebar Cage" (lowering the rebar cage), ' +
  '"Concrete Casting", "Trimming" (trimming/chipping), "Breaking" (breaking/hacking), ' +
  '"Completed", or "Other". Use "Completed" ONLY when the element/panel as a whole is ' +
  'finished (e.g. its concrete casting is done) — NOT merely because a sub-step like ' +
  'excavation finished (that is still "Excavation").\n\n' +
  '8. RESOURCE & PRODUCTION (heavy machinery + production nodes):\n' +
  'Populate machineStatus, excavation and reinforcedConcrete. For machineStatus apply these ' +
  'STRICT LOGICAL TRIGGERS — do NOT log a machine unless its trigger is present in the text:\n' +
  '- A BC Cutter works Diaphragm Walls (DW), Buttress Walls (BT) and Cross Walls (CW); a ' +
  'Boring Rig works Bored Piles (BP / P-number piles). Log a BC Cutter ONLY when a DW/BT/CW ' +
  'has "bite"; log a Boring Rig ONLY when a BP has "depth" (current/drilling depth). Rebar ' +
  'cage and concrete casting are NOT machine triggers — an element with only rebar cage or ' +
  'casting (and no bite/depth) must NOT be logged on a machine. They only set the ' +
  'lifecycleStage of an element already logged via bite/depth (rebar cage = Rebar; casting = ' +
  'Concreting, or Completed when done). If an element has no bite (BC) / depth (rig), do NOT ' +
  'log it.\n' +
  '- NEST the worked elements inside the machine: each machine object is { machineId, area, ' +
  'location, machineState, workingOnElements:[{ elementId, lifecycleStage, depth }], evidence }. ' +
  '"lifecycleStage" is exactly "Excavation", "Rebar", "Concreting", or "Completed" (the ' +
  'stage that element reached). "depth" = that element\'s current dug/drilling depth in ' +
  'metres if the text states one (e.g. "1st bite 21.5m" -> 21.5, "current depth 27.5m" -> ' +
  '27.5), else 0. GROUP every element one machine worked at one location into ' +
  'that machine\'s workingOnElements array (a machine can finish one and start the next).\n' +
  '- "machineId" = the machine name if stated, else a generic slot like "BC Cutter 1". ' +
  '"area" = "Area 1".."Area 4"/"Others" (site-plan map). "location" = the site location ' +
  '(ER15, Opp SJII). "machineState" is exactly "Active", "Maintenance" (hose change / ' +
  'breakdown / repair / servicing), or "Idle". There are 6 BC Cutters and 4 Boring Rigs: ' +
  'machines with no element reported are Idle; never exceed 6 cutters / 4 rigs. "evidence" ' +
  '= the snippet containing the trigger ("DW1547 1st bite : 21.50m", "Current depth: 27.5m").\n' +
  '- excavation.activeExcavations: one entry per active excavation zone with { location, ' +
  'currentDepth (metres, number), activity }. excavation.totalVolumeOrLoads = the total ' +
  'soil-disposal LOADS for the day if stated (a number), else 0.\n' +
  '- reinforcedConcrete.totalConcreteVolumeM3 = the total concrete cast (m3), using the ' +
  'CONCRETE VOLUME rules in section 6. reinforcedConcrete.rcActivities: one entry per RC ' +
  'work item with { location, type, activity }, where "type" is exactly "Rebar", ' +
  '"Concreting", or "Formwork".';

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
                    activityDescription: { type: 'string', description: 'the work description; keep any volume figure such as "54/54 m3"' },
                    stage: { type: 'string', description: 'construction stage: Guide Wall | Excavation | Rebar Cage | Concrete Casting | Trimming | Breaking | Completed | Other' },
                    manpower: { type: 'integer', description: 'manpower for this activity (0 if unknown)' }
                  },
                  required: ['elementId', 'section', 'activityDescription', 'stage', 'manpower']
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
        },
        machineStatus: {
          type: 'object',
          description: 'heavy-machinery fleet (6 BC Cutters, 4 Boring Rigs) with the elements each is working',
          properties: {
            bcCutters: {
              type: 'array',
              description: 'BC Cutters working DW/BT/CW (bite / rebar cage / casting)',
              items: {
                type: 'object',
                properties: {
                  machineId: { type: 'string', description: 'e.g. "BC Cutter 1" (infer from text, else a generic slot name)' },
                  area: { type: 'string', description: 'which Area: "Area 1".."Area 4" (or "Others")' },
                  location: { type: 'string', description: 'specific site location, e.g. ER15' },
                  machineState: { type: 'string', description: 'Active | Maintenance | Idle (the machine\'s own state)' },
                  workingOnElements: {
                    type: 'array',
                    description: 'the DW/BT/CW this machine worked today, each with its lifecycle stage',
                    items: {
                      type: 'object',
                      properties: {
                        elementId: { type: 'string', description: 'e.g. DW1547' },
                        lifecycleStage: { type: 'string', description: 'Excavation | Rebar | Concreting | Completed' },
                        depth: { type: 'number', description: 'current dug depth in metres if stated (e.g. 21.5), else 0' },
                        location: { type: 'string', description: 'this element\'s own site location if it differs from the machine (else "")' }
                      },
                      required: ['elementId', 'lifecycleStage']
                    }
                  },
                  evidence: { type: 'string', description: 'snippet with the trigger, e.g. "DW1547 1st bite : 21.50m"' }
                },
                required: ['machineId', 'area', 'location', 'machineState', 'workingOnElements', 'evidence']
              }
            },
            boringRigs: {
              type: 'array',
              description: 'Boring Rigs working BP/pile (depth / rebar cage / casting)',
              items: {
                type: 'object',
                properties: {
                  machineId: { type: 'string', description: 'e.g. "Boring Rig 1" (infer from text, else a generic slot name)' },
                  area: { type: 'string', description: 'which Area: "Area 1".."Area 4" (or "Others")' },
                  location: { type: 'string', description: 'specific site location, e.g. Opp SJII' },
                  machineState: { type: 'string', description: 'Active | Maintenance | Idle' },
                  workingOnElements: {
                    type: 'array',
                    description: 'the BP/piles this rig worked today, each with its lifecycle stage',
                    items: {
                      type: 'object',
                      properties: {
                        elementId: { type: 'string', description: 'e.g. BP-T9-3' },
                        lifecycleStage: { type: 'string', description: 'Excavation | Rebar | Concreting | Completed' },
                        depth: { type: 'number', description: 'current drilling depth in metres if stated (e.g. 27.5), else 0' },
                        location: { type: 'string', description: 'this pile\'s own site location if it differs from the rig (else "")' }
                      },
                      required: ['elementId', 'lifecycleStage']
                    }
                  },
                  evidence: { type: 'string', description: 'snippet with the trigger, e.g. "Current depth: 27.5m"' }
                },
                required: ['machineId', 'area', 'location', 'machineState', 'workingOnElements', 'evidence']
              }
            }
          },
          required: ['bcCutters', 'boringRigs']
        },
        excavation: {
          type: 'object',
          properties: {
            totalVolumeOrLoads: { type: 'number', description: 'total soil-disposal loads for the day (0 if unknown)' },
            activeExcavations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  location: { type: 'string', description: 'e.g. CW323' },
                  currentDepth: { type: 'number', description: 'depth reached in metres (0 if unknown)' },
                  activity: { type: 'string', description: 'e.g. 1st bite excavation ongoing' }
                },
                required: ['location', 'currentDepth', 'activity']
              }
            }
          },
          required: ['totalVolumeOrLoads', 'activeExcavations']
        },
        reinforcedConcrete: {
          type: 'object',
          properties: {
            totalConcreteVolumeM3: { type: 'number', description: 'total concrete cast (m3)' },
            rcActivities: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  location: { type: 'string', description: 'e.g. BP Qd4-2' },
                  type: { type: 'string', description: 'Rebar | Concreting | Formwork' },
                  activity: { type: 'string', description: 'e.g. Casting preparation works, 84m3' }
                },
                required: ['location', 'type', 'activity']
              }
            }
          },
          required: ['totalConcreteVolumeM3', 'rcActivities']
        }
      },
      required: ['date', 'areas', 'grandTotals', 'machineStatus', 'excavation', 'reinforcedConcrete']
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
    'ALSO populate the Resource & Production nodes (see rule 8):\n' +
    '   - "machineStatus": { bcCutters:[…], boringRigs:[…] } using the triggers in rule 8. ' +
    'NEST the worked elements: each machine = { machineId, area, location, machineState, ' +
    'workingOnElements:[{ elementId, lifecycleStage, depth }], evidence }. depth = the ' +
    'element\'s dug/drilling depth in metres if stated (else 0). lifecycleStage ∈ ' +
    'Excavation | Rebar | Concreting | Completed (bite/depth→Excavation, rebar cage→Rebar, ' +
    'casting→Concreting/Completed). Group every element one machine worked at one location ' +
    'into its workingOnElements. machineState ∈ Active | Maintenance | Idle. 6 BC Cutters + ' +
    '4 Boring Rigs — unreported machines are Idle; do NOT log an element without a trigger.\n' +
    '   - "excavation": { totalVolumeOrLoads, activeExcavations:[{location,currentDepth,activity}] }.\n' +
    '   - "reinforcedConcrete": { totalConcreteVolumeM3, rcActivities:[{location,type,activity}] } ' +
    'with type = Rebar | Concreting | Formwork.\n\n' +
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
    output_config: { effort: 'medium' },   // 'low' dropped activities; medium is more complete
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
        stage: normStage_(a.stage) || stageFromText_(activity),
        manpower: num(a.manpower)
      });
    });
  });
  acts = acts.filter(function (a) { return a.activity; });
  var date = normalizeDate_(raw.date) || dateHint || str(raw.date);
  var result = buildProductivityResult_(date, acts, source || 'ai');
  // Overlay the AI's Resource & Production nodes on top of the inference baseline
  // that buildProductivityResult_ already attached (AI entries win; inference fills).
  result.machineStatus = normalizeMachineStatus_(raw.machineStatus, result.mergedActivities);
  result.excavation = normalizeExcavation_(raw.excavation, result.mergedActivities);
  result.reinforcedConcrete = normalizeRC_(raw.reinforcedConcrete, result.mergedActivities,
    result.grandTotals.totalConcreteVolumeM3);
  return result;
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
 * in that area's activities (so counts reconcile with the rows), computes concrete
 * casting (per-panel, latest, LSS excluded) and manpower, and rolls up grand
 * totals. Also returns a flattened mergedActivities for the Sheet.
 */
function buildProductivityResult_(date, acts, source) {
  var ORDER = ['Area 1', 'Area 2', 'Area 3', 'Area 4', 'Others'];
  var byArea = {};
  acts.forEach(function (a) {
    a.area = areaFromSection_(a.section) || normAreaName_(a.area) || 'Others';
    (byArea[a.area] = byArea[a.area] || []).push(a);
  });
  var areas = Object.keys(byArea).sort(function (x, y) {
    var ix = ORDER.indexOf(x), iy = ORDER.indexOf(y);
    return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
  }).map(function (area) {
    var list = byArea[area];
    var dw = [], bp = [], bt = [], cw = [], manpower = 0, castByPanel = {};
    list.forEach(function (a) {
      var blob = (a.elementId || '') + ' ' + (a.activity || '');
      matchAll_(blob, new RegExp(ELEMENT_RE.source, 'gi')).forEach(function (code) {
        var t = classifyElement_(code);
        if (t === 'DW') dw.push(code); else if (t === 'BP') bp.push(code);
        else if (t === 'BT') bt.push(code); else if (t === 'CW') cw.push(code);
      });
      // Concrete casting from the activity text; keep the highest per panel (count once).
      var vol = castVolumeOf_(a.activity || '');
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
          activity: a.activity || '', stage: a.stage || stageFromText_(a.activity || ''),
          manpower: Number(a.manpower) || 0 };
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

  var mergedActivities = acts.map(function (a) {
    return { area: a.area, section: a.section || '', elementId: a.elementId || '',
      activity: a.activity || '', stage: a.stage || stageFromText_(a.activity || ''),
      manpower: Number(a.manpower) || 0 };
  });

  return {
    date: date,
    areas: areas,
    grandTotals: { totalConcreteVolumeM3: Math.round(gConc * 100) / 100, totalManpower: gMan },
    mergedActivities: mergedActivities,
    productivityData: {
      activeDWalls: gdw, dWallCount: gdw.length,
      activeBoredPiles: gbp, bPileCount: gbp.length,
      activeButtressWalls: gbt, bWallCount: gbt.length,
      activeCrossWalls: gcw, cWallCount: gcw.length,
      totalConcreteVolumeM3: Math.round(gConc * 100) / 100, totalManpower: gMan
    },
    // Resource & Production baseline — derived purely by inference from the activities.
    // normalizeProductivity_ overlays the AI's richer nodes on top of this on the AI path.
    machineStatus: normalizeMachineStatus_(null, mergedActivities),
    excavation: normalizeExcavation_(null, mergedActivities),
    reinforcedConcrete: normalizeRC_(null, mergedActivities, Math.round(gConc * 100) / 100),
    source: source || 'ai'
  };
}

/* ======================================================================
 * RESOURCE & PRODUCTION nodes (machine fleet / excavation / RC).
 * Each normaliser takes the AI's raw node (or null on the offline path) plus the
 * flat mergedActivities, and returns a clean node. Machine deployments not stated
 * by the AI are INFERRED from the worked elements: DW/BT/CW -> a BC Cutter,
 * BP -> a Boring Rig, capped at the physical fleet sizes.
 * ==================================================================== */

var FLEET = { bcCutters: 6, boringRigs: 4 };

function toNum_(v) { var n = Number(v); return isFinite(n) ? n : 0; }
function round2_(n) { return Math.round(toNum_(n) * 100) / 100; }
function locKey_(s) { return String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ''); }

// Machine-detection triggers. An element is "being worked" (and its machine logged) only
// when its text hits one of the three work stages: bite (DW/BT/CW) / depth (BP) = Excavation,
// rebar cage = Rebar, or concrete casting = Concreting/Completed.
var CASTING_RE = /cast|concret|pour/i;
var MAINT_RE = /maint|breakdown|repair|servic|hose\s*change/i;
var BITE_RE = /\bbite\b/i;
var DEPTH_RE = /\bdepth\b/i;
var REBAR_CAGE_RE = /rebar|reinforc|steel\s*fix/i;

// Element lifecycle stages, ordered so a stage only ever advances.
var LIFECYCLE = ['Excavation', 'Rebar', 'Concreting', 'Completed'];
var LIFECYCLE_RANK = { Excavation: 1, Rebar: 2, Concreting: 3, Completed: 4 };

/**
 * Trigger for a machine of `family` ('bc' | 'rig'): 'bite' (bc) or 'depth' (rig), else '' to
 * DROP. ONLY "bite" attaches an element to a BC Cutter; ONLY "depth" attaches one to a Boring
 * Rig. Rebar cage / casting are NOT machine triggers — they only refine the lifecycle stage of
 * an element that is already attached via bite/depth.
 */
function machineTrigger_(text, family) {
  var t = String(text == null ? '' : text);
  if (family === 'bc') return BITE_RE.test(t) ? 'bite' : '';
  if (family === 'rig') return DEPTH_RE.test(t) ? 'depth' : '';
  return '';
}

/** Map evidence text to a lifecycle stage (Excavation | Rebar | Concreting | Completed | ''). */
function lifecycleStageFor_(text) {
  var t = String(text == null ? '' : text);
  if (CASTING_RE.test(t)) return /\b(complete|completed|finished|done)\b/i.test(t) ? 'Completed' : 'Concreting';
  if (REBAR_CAGE_RE.test(t)) return 'Rebar';
  if (BITE_RE.test(t) || DEPTH_RE.test(t) || /excavat/i.test(t)) return 'Excavation';
  return '';
}

/** Canonicalise a lifecycle stage string, or '' if not one of the four. */
function clampLifecycle_(v) {
  var s = String(v == null ? '' : v).trim();
  for (var i = 0; i < LIFECYCLE.length; i++) if (LIFECYCLE[i].toLowerCase() === s.toLowerCase()) return LIFECYCLE[i];
  return '';
}

/** Forward-only stage merge for the ElementTracker: return the more-advanced stage. */
function elementStageForward_(oldStage, newStage) {
  var ro = LIFECYCLE_RANK[clampLifecycle_(oldStage)] || 0;
  var rn = LIFECYCLE_RANK[clampLifecycle_(newStage)] || 0;
  return rn > ro ? clampLifecycle_(newStage) : (clampLifecycle_(oldStage) || clampLifecycle_(newStage) || '');
}

/** Machine's own state from evidence: Maintenance on a maintenance keyword, else Active. */
function machineStateFor_(text) { return MAINT_RE.test(String(text == null ? '' : text)) ? 'Maintenance' : 'Active'; }

/** The clause of `text` that contains the trigger, so the UI can show why it was logged. */
function machineEvidence_(text, family) {
  var full = String(text == null ? '' : text).trim();
  // Split on ; , newline, or a sentence period (one followed by space/end) — never a
  // decimal point, so "21.5m" / "27.5m" stay intact.
  var clauses = full.split(/\s*(?:;|\n|,|\.(?=\s|$))\s*/).filter(Boolean);
  var res = [(family === 'rig' ? DEPTH_RE : BITE_RE), REBAR_CAGE_RE, CASTING_RE, MAINT_RE];
  for (var i = 0; i < clauses.length; i++) {
    for (var j = 0; j < res.length; j++) { if (res[j].test(clauses[i])) return clauses[i].trim(); }
  }
  return full;
}

/**
 * Unified machine + element-lifecycle status. Returns
 *   { bcCutters:[…6…], boringRigs:[…4…] }
 * where each machine = { machineId, family, area, location, machineState, evidence,
 *   workingOnElements:[{ elementId, lifecycleStage }] }.
 * Elements are grouped into machines by area+location (a machine may hold several); when
 * more element-groups than the physical fleet exist, overflow elements fold into existing
 * machines (one finished, started the next). Each fleet is PADDED to 6 / 4 with Idle slots.
 * Applies to BOTH the AI's nested entries and the deterministic inference.
 */
function normalizeMachineStatus_(raw, mergedActivities) {
  raw = raw || {};
  var cards = {}, order = [], counts = { bc: 0, rig: 0 };
  // An element belongs to exactly ONE machine of its family (global dedup). Maps a
  // normalised elementId -> the card that owns it.
  var claimedBy = { bc: {}, rig: {} };
  // Authoritative area per worked element, from the activity it appears in (a section like
  // "Sec-C/Mb" resolves to Area 2 even when the machine's location is a bare "ER15").
  var elArea = {};
  (mergedActivities || []).forEach(function (a) {
    var id = a.elementId || firstElementId_((a.section || '') + ' ' + (a.activity || ''));
    if (!id) return;
    var n = id.toUpperCase().replace(/\s+/g, '');
    var ar = areaFromSection_(a.section) || normAreaName_(a.area) || '';
    if (ar && !elArea[n]) elArea[n] = ar;   // first real "Area N" wins
  });

  function overflowCard(family, area) {
    var want = String(area || '').toUpperCase();
    var fams = order.map(function (k) { return cards[k]; }).filter(function (c) {
      // Only fold into a machine of the SAME family AND SAME area — never mix areas.
      return c.family === family && String(c.area || '').toUpperCase() === want;
    });
    if (!fams.length) return null;
    fams.sort(function (a, b) { return a.workingOnElements.length - b.workingOnElements.length; });
    return fams[0];   // append to the least-loaded machine of this family in this area
  }

  function addElement(family, area, location, elementId, stage, evidence, machineIdHint, depthHint) {
    var ev = String(evidence == null ? '' : evidence).trim();
    // HARD GATE (always applied): an element attaches ONLY when its own evidence has the
    // family trigger — "bite" for a BC Cutter, "depth" for a Boring Rig. Casting / rebar cage
    // alone never attach (they only refine an already-attached element's stage).
    if (!machineTrigger_(ev, family)) return;
    stage = clampLifecycle_(stage) || lifecycleStageFor_(ev) || 'Excavation';
    var eid = String(elementId == null ? '' : elementId).trim();
    var n = eid ? eid.toUpperCase().replace(/\s+/g, '') : '';
    // Depth (metres) belongs to the element: prefer an AI-supplied value, else parse the
    // evidence/activity ("1st bite 21.5m", "current depth 27.5m").
    var depth = toNum_(depthHint);
    if (!depth) depth = parseDepthM_(ev);
    depth = (depth === null || depth === undefined || !isFinite(depth) || depth <= 0) ? null : toNum_(depth);

    // GLOBAL dedup: if this element is already on a machine, advance its stage there and
    // stop — never place the same element on a second machine.
    if (n && claimedBy[family][n]) {
      var owner = claimedBy[family][n];
      var eloc0 = String(location == null ? '' : location).trim();
      for (var j = 0; j < owner.workingOnElements.length; j++) {
        var ow = owner.workingOnElements[j];
        if (String(ow.elementId).toUpperCase().replace(/\s+/g, '') === n) {
          ow.lifecycleStage = elementStageForward_(ow.lifecycleStage, stage);
          if (depth !== null) ow.depth = depth;   // keep the latest reported depth
          if (eloc0 && !ow.location) ow.location = eloc0;  // fill a missing per-element location
          break;
        }
      }
      if (MAINT_RE.test(ev)) owner.machineState = 'Maintenance';
      return;
    }

    // Area comes from the element's activity first (so ER15 -> Area 2), then the AI's area,
    // then the location/element codes.
    area = (n && elArea[n]) || areaFromSection_(location) || areaFromSection_(eid) || normAreaName_(area) || '';
    var loc = String(location == null ? '' : location).trim();
    var key = family + '|' + area.toUpperCase() + '|' + locKey_(loc);
    var card = cards[key];
    if (!card) {
      // Build uncapped here; foldToCap_ enforces the hard fleet cap (<=6/<=4) afterwards by
      // merging same-area cards. (No soft cap — the fleet total must never be exceeded.)
      card = { family: family, machineId: String(machineIdHint == null ? '' : machineIdHint).trim(),
        area: area, location: loc, machineState: 'Active', workingOnElements: [], evidence: '' };
      cards[key] = card; order.push(key); counts[family]++;
    }
    if (eid) {
      card.workingOnElements.push({ elementId: eid, lifecycleStage: stage, depth: depth, location: loc, area: area });
      claimedBy[family][n] = card;
    }
    if (MAINT_RE.test(ev)) card.machineState = 'Maintenance';
    if (machineIdHint && !card.machineId) card.machineId = String(machineIdHint).trim();
    var snip = machineEvidence_(ev, family);
    if (snip && card.evidence.indexOf(snip) === -1) card.evidence = card.evidence ? (card.evidence + '; ' + snip) : snip;
    if (!card.area && area) card.area = area;
  }

  // 1) AI entries — nested workingOnElements; tolerate legacy assignedIds/assignedId/id.
  ['bc', 'rig'].forEach(function (fam) {
    var list = fam === 'bc' ? raw.bcCutters : raw.boringRigs;
    (Array.isArray(list) ? list : []).forEach(function (m) {
      m = m || {};
      var ev = m.evidence != null ? m.evidence : (m.activity || '');
      if (Array.isArray(m.workingOnElements) && m.workingOnElements.length) {
        m.workingOnElements.forEach(function (e) {
          e = e || {};
          addElement(fam, m.area, (e.location || m.location), e.elementId, clampLifecycle_(e.lifecycleStage), ev, m.machineId, e.depth);
        });
      } else {
        var ids = Array.isArray(m.assignedIds) ? m.assignedIds
          : (m.assignedId != null ? [m.assignedId] : (m.id != null ? [m.id] : []));
        if (ids.length) ids.forEach(function (id) { addElement(fam, m.area, m.location, id, '', ev, m.machineId); });
        else if (machineTrigger_(ev, fam)) addElement(fam, m.area, m.location, '', lifecycleStageFor_(ev), ev, m.machineId);
      }
    });
  });

  // 2) Deterministic inference from the activities — same gate on the activity text.
  (mergedActivities || []).forEach(function (a) {
    var id = a.elementId || firstElementId_((a.section || '') + ' ' + (a.activity || ''));
    var t = classifyElement_(id);
    if (!t) return;
    var fam = (t === 'BP') ? 'rig' : 'bc';
    if (!machineTrigger_(a.activity || '', fam)) return;
    addElement(fam, a.area, a.section || id || '', id, lifecycleStageFor_(a.activity || ''), a.activity || '', '');
  });

  // Hard fleet cap: while a family has more cards than its fleet size, merge the two
  // least-loaded cards OF THE SAME AREA (a machine that finished one element and moved to the
  // next). Only ever merges within one area, so areas never mix; #distinct areas <= cap, so
  // the cap is always reachable. Never pads with Idle — only deployed machines are returned.
  var STATE_RANK = { 'Maintenance': 3, 'Active': 2, 'Idle': 1 };
  function mergeCards_(dst, src) {
    src.workingOnElements.forEach(function (e) { dst.workingOnElements.push(e); });
    if (src.evidence && dst.evidence.indexOf(src.evidence) === -1) dst.evidence = dst.evidence ? (dst.evidence + '; ' + src.evidence) : src.evidence;
    if ((STATE_RANK[src.machineState] || 0) > (STATE_RANK[dst.machineState] || 0)) dst.machineState = src.machineState;
  }
  function foldToCap_(family) {
    var cap = family === 'bc' ? FLEET.bcCutters : FLEET.boringRigs;
    var list = order.map(function (k) { return cards[k]; }).filter(function (c) { return c.family === family; });
    while (list.length > cap) {
      // group by area; pick an area with >= 2 cards (most cards first) and merge its two smallest
      var byArea = {}, areasWith2 = [];
      list.forEach(function (c) { (byArea[c.area] = byArea[c.area] || []).push(c); });
      Object.keys(byArea).forEach(function (a) { if (byArea[a].length >= 2) areasWith2.push(a); });
      var pickArea;
      if (areasWith2.length) {
        areasWith2.sort(function (a, b) { return byArea[b].length - byArea[a].length; });
        pickArea = areasWith2[0];
      } else {
        // Fallback (shouldn't happen: #areas <= cap): merge the two globally smallest.
        pickArea = null;
      }
      var pool = pickArea ? byArea[pickArea] : list.slice();
      pool.sort(function (a, b) { return a.workingOnElements.length - b.workingOnElements.length; });
      var keep = pool[0], drop = pool[1];
      mergeCards_(keep, drop);
      // remove drop from cards/order/list
      var dropKey = null; Object.keys(cards).forEach(function (k) { if (cards[k] === drop) dropKey = k; });
      if (dropKey) { delete cards[dropKey]; order = order.filter(function (k) { return k !== dropKey; }); }
      list = order.map(function (k) { return cards[k]; }).filter(function (c) { return c.family === family; });
    }
    var label = family === 'bc' ? 'BC Cutter ' : 'Boring Rig ';
    list.forEach(function (c, i) {
      if (!c.machineId) c.machineId = label + (i + 1);
      if (c.machineState !== 'Maintenance') c.machineState = c.workingOnElements.length ? 'Active' : 'Idle';
    });
    return list;
  }
  return { bcCutters: foldToCap_('bc'), boringRigs: foldToCap_('rig') };
}

/** Parse a depth in metres from text ("24.2 m" -> 24.2), never matching "m3"/"m³". */
function parseDepthM_(t) {
  var m = /(\d+(?:\.\d+)?)\s*m(?![0-9³a-z])/i.exec(String(t == null ? '' : t));
  return m ? parseFloat(m[1]) : null;
}

/** Parse a soil-disposal load count ("14 loads" -> 14). */
function parseLoads_(t) {
  var m = /(\d+)\s*loads?\b/i.exec(String(t == null ? '' : t));
  return m ? parseInt(m[1], 10) : 0;
}

/** {totalVolumeOrLoads:number, activeExcavations:[{location,currentDepth,activity}]}. */
function normalizeExcavation_(raw, mergedActivities) {
  raw = raw || {};
  var zones = (Array.isArray(raw.activeExcavations) ? raw.activeExcavations : []).map(function (z) {
    z = z || {};
    var depth = toNum_(z.currentDepth) || parseDepthM_(z.activity);
    return {
      location: String(z.location == null ? '' : z.location).trim(),
      currentDepth: (depth === null || depth === undefined) ? null : toNum_(depth),
      activity: String(z.activity == null ? '' : z.activity).trim()
    };
  }).filter(function (z) { return z.location || z.activity; });

  // Offline / no raw zones: derive from excavation-stage activities.
  if (!zones.length) {
    (mergedActivities || []).forEach(function (a) {
      if (a.stage === 'Excavation' || /excavat/i.test(a.activity || '')) {
        zones.push({
          location: a.elementId || a.section || '',
          currentDepth: parseDepthM_(a.activity),
          activity: a.activity || ''
        });
      }
    });
  }
  var total = toNum_(raw.totalVolumeOrLoads);
  if (!total) {
    (mergedActivities || []).forEach(function (a) { total += parseLoads_(a.activity || ''); });
  }
  return { totalVolumeOrLoads: total, activeExcavations: zones };
}

/** Classify an RC work item into Rebar / Concreting / Formwork. */
function classifyRcType_(text) {
  var t = String(text == null ? '' : text).toLowerCase();
  if (/cast|concret|pour/.test(t)) return 'Concreting';
  if (/rebar|cage|reinforc|steel\s*fix/.test(t)) return 'Rebar';
  if (/formwork|shutter|form\s*work/.test(t)) return 'Formwork';
  return 'Concreting';
}

/** {totalConcreteVolumeM3:number, rcActivities:[{location,type,activity}]}. */
function normalizeRC_(raw, mergedActivities, grandConcrete) {
  raw = raw || {};
  var acts = (Array.isArray(raw.rcActivities) ? raw.rcActivities : []).map(function (r) {
    r = r || {};
    var activity = String(r.activity == null ? '' : r.activity).trim();
    return {
      location: String(r.location == null ? '' : r.location).trim(),
      type: classifyRcType_(r.type || activity),
      activity: activity
    };
  }).filter(function (r) { return r.location || r.activity; });

  // Offline / no raw items: derive from casting / rebar / formwork activities.
  if (!acts.length) {
    (mergedActivities || []).forEach(function (a) {
      if (/cast|concret|pour|rebar|cage|reinforc|formwork|shutter/i.test(a.activity || '')) {
        acts.push({
          location: a.elementId || a.section || '',
          type: classifyRcType_(a.activity),
          activity: a.activity || ''
        });
      }
    });
  }
  var total = toNum_(raw.totalConcreteVolumeM3) || toNum_(grandConcrete);
  return { totalConcreteVolumeM3: round2_(total), rcActivities: acts };
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
    // Fold any remark into the activity text so a volume in the remark is still counted.
    var full = (r.remark ? (act + ' — ' + r.remark) : act).trim();
    acts.push({
      area: r.areaGroup || areaFromSection_(r.area) || '',
      section: r.area || '',
      elementId: firstElementId_((r.area || '') + ' ' + act),
      activity: full,
      stage: stageFromText_(full),
      manpower: firstManpower_((r.remark || '') + ' ' + act)
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

// Construction stages, ordered by progress (later = more advanced). "Other" = -1.
var STAGES = ['Guide Wall', 'Excavation', 'Rebar Cage', 'Concrete Casting', 'Trimming', 'Breaking', 'Completed', 'Other'];
var STAGE_ORDER = { 'Guide Wall': 0, 'Excavation': 1, 'Rebar Cage': 2, 'Concrete Casting': 3, 'Trimming': 4, 'Breaking': 5, 'Completed': 6, 'Other': -1 };

/**
 * Classify an activity's construction stage from its text. Picks the most-advanced
 * construction step present; maps to "Completed" only when a completion word
 * co-occurs with casting or an explicit element/panel completion (so "excavation
 * completed" stays Excavation, but "concrete casting completed" -> Completed).
 */
function stageFromText_(text) {
  var t = String(text == null ? '' : text).toLowerCase();
  var found = -1;
  if (/guide\s*wall/.test(t)) found = Math.max(found, 0);
  if (/excavat|trench/.test(t)) found = Math.max(found, 1);
  if (/rebar|cage|reinforc|steel\s*fix/.test(t)) found = Math.max(found, 2);
  if (/cast|concret|pour/.test(t)) found = Math.max(found, 3);
  if (/trim|chip|chisel/.test(t)) found = Math.max(found, 4);
  if (/break|hack|demolish/.test(t)) found = Math.max(found, 5);
  var done = /\b(complete|completed|finished|done|fully\s*cast)\b/.test(t);
  var casting = /cast|concret|pour/.test(t);
  var elemDone = /\b(panel|wall|pile|element|works?)\b[^.]*\b(complete|completed|finished|done)\b/.test(t)
    || /\b(complete|completed|finished|done)\b[^.]*\b(panel|wall|pile|element)\b/.test(t);
  if (done && (casting || elemDone)) return 'Completed';
  return found >= 0 ? STAGES[found] : 'Other';
}

/** Canonicalise an AI-provided stage label to one of STAGES, or '' if unrecognised. */
function normStage_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return '';
  for (var i = 0; i < STAGES.length; i++) if (STAGES[i].toLowerCase() === s) return STAGES[i];
  if (/guide/.test(s)) return 'Guide Wall';
  if (/excavat|trench/.test(s)) return 'Excavation';
  if (/rebar|cage|reinforc/.test(s)) return 'Rebar Cage';
  if (/cast|concret|pour/.test(s)) return 'Concrete Casting';
  if (/trim|chip/.test(s)) return 'Trimming';
  if (/break|hack/.test(s)) return 'Breaking';
  if (/complet|finish|done/.test(s)) return 'Completed';
  return '';
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
// Progressive "X/Y" casting notation, with the m3 unit on either or both sides:
// "54/54 m3", "84.0m3/84.0m3", "200m3/202m3", "55/100m3" -> captures current cast X.
var PROGRESSIVE_RE = /(\d+(?:\.\d+)?)\s*(?:m3|m³|cum|cu\.?\s?m)?\s*\/\s*\d+(?:\.\d+)?\s*(?:m3|m³|cum|cu\.?\s?m)(?![a-z0-9])/gi;

function castVolumeOf_(text) {
  var t = String(text == null ? '' : text);
  // 1) Drop LSS / backfill clauses entirely (even when written in X/Y form, e.g.
  //    "…, then LSS backfilling reaching 100/107 m3"); keep the rest.
  var clauses = t.split(/\s*(?:\+|;|,|\band\b|\bthen\b|\n)\s*/i);
  var kept = [];
  for (var i = 0; i < clauses.length; i++) {
    if (/\blss\b/i.test(clauses[i]) || /back\s*fill/i.test(clauses[i])) continue;
    kept.push(clauses[i]);
  }
  var clean = kept.join(' ');
  // 2) Progressive X/Y -> current cast X (max across the kept text). Because a
  //    comma may separate "…casting…" from "…actual volume X/Y…", we evaluate the
  //    whole kept text, not each clause.
  var best = 0, m; PROGRESSIVE_RE.lastIndex = 0;
  while ((m = PROGRESSIVE_RE.exec(clean)) !== null) best = Math.max(best, parseFloat(m[1]));
  if (best) return best;
  // 3) Otherwise a plain "N m3" only in a casting context; ignore "theoretical" volumes.
  if (/\b(cast|concret|pour)/i.test(clean)) {
    return sumConcreteM3_(clean.replace(/theoretical\s*\d+(?:\.\d+)?\s*(?:m3|m³|cum|cu\.?\s?m)/gi, ' '));
  }
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
    stageFromText_: stageFromText_,
    uniqCodes_: uniqCodes_,
    sumConcreteM3_: sumConcreteM3_,
    castVolumeOf_: castVolumeOf_,
    normalizeMachineStatus_: normalizeMachineStatus_,
    machineTrigger_: machineTrigger_,
    machineStateFor_: machineStateFor_,
    lifecycleStageFor_: lifecycleStageFor_,
    elementStageForward_: elementStageForward_,
    clampLifecycle_: clampLifecycle_,
    machineEvidence_: machineEvidence_,
    normalizeExcavation_: normalizeExcavation_,
    normalizeRC_: normalizeRC_,
    classifyRcType_: classifyRcType_,
    parseDepthM_: parseDepthM_,
    parseLoads_: parseLoads_
  };
}
