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
var DEFAULT_MODEL = 'claude-opus-5';

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
    'You extract daily construction site progress records from a WhatsApp chat ' +
    'export for project N106. Each real record has a locator like "Sec-C/ER15(Mb)" ' +
    '(Section A-E + a site-plan segment code such as Mb, Ub, Ld, Ta) followed by the ' +
    'work done. Rules:\n' +
    '- Return ONE record per distinct site report. Combine a report with its ' +
    'immediately-following photo messages (count them into "photos").\n' +
    '- Put the Section into "section" (format "Sec-X") and the segment code into ' +
    '"segment"; leave them "" if genuinely absent.\n' +
    '- "activity" = the full work description text (keep it complete, do not summarise).\n' +
    '- "remark" = manpower or trailing notes.\n' +
    '- IGNORE greetings, acknowledgements, emoji-only messages, questions/RFIs and ' +
    'any coordination chatter that is not a site progress report.\n' +
    '- "date" is the message date as ISO yyyy-mm-dd.\n' +
    'Call emit_records with every record you find.\n\n' +
    'CHAT EXPORT:\n' + text;

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
 * WORK SUMMARY — cross-compare RTO field notes vs the AIS daily report and
 * produce an executive summary for directors. AI path (Claude) with a
 * deterministic fallback built from the parsed records.
 * ==================================================================== */

/**
 * @param {string} rtoText  RTO (Resident Technical Officer) raw notes
 * @param {string} aisText  AIS Daily Report raw data
 * @return {Object} canonical summary (see normalizeSummary_)
 */
function generateWorkSummary(rtoText, aisText) {
  var key = getApiKey_();
  if (key) {
    try {
      var s = callClaudeSummary_(rtoText, aisText, key);
      if (s) return s;
    } catch (err) {
      try { console.error('AI summary failed, using fallback: ' + err); } catch (e) {}
    }
  }
  return summaryFromRecords_(rtoText, aisText);
}

/** Claude forced-tool cross-comparison. */
function callClaudeSummary_(rtoText, aisText, key) {
  var tool = {
    name: 'emit_summary',
    description: 'Return the executive cross-comparison of the RTO notes vs the AIS daily report.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'report date, ISO yyyy-mm-dd' },
        executiveSummary: {
          type: 'array', items: { type: 'string' },
          description: '3-5 concise high-level bullet points of the day'
        },
        sectionBreakdown: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              area: { type: 'string', description: 'Area 1-4 (or "")' },
              section: { type: 'string', description: 'Section/segment e.g. Sec-C/Mb' },
              work: { type: 'string', description: 'work completed there' }
            },
            required: ['area', 'section', 'work']
          }
        },
        rtoVsAisDiscrepancies: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string', description: 'location/topic of the difference' },
              rto: { type: 'string', description: 'what the RTO notes say' },
              ais: { type: 'string', description: 'what the AIS report says' },
              severity: { type: 'string', description: 'low | medium | high' }
            },
            required: ['item', 'rto', 'ais', 'severity']
          }
        },
        manpowerAndRemarks: {
          type: 'array', items: { type: 'string' },
          description: 'key manpower, equipment, safety/quality highlights'
        }
      },
      required: ['date', 'executiveSummary', 'sectionBreakdown', 'rtoVsAisDiscrepancies', 'manpowerAndRemarks']
    }
  };

  var prompt =
    'You are preparing an executive daily site summary for project N106 management. ' +
    'Cross-compare two inputs: (A) the RTO (Resident Technical Officer) field notes and ' +
    '(B) the AIS Daily Report. Sections are Sec-A..E with site-plan segment codes ' +
    '(Mb, Ub, Ld, Ta...) grouped into Area 1-4. Produce:\n' +
    '- executiveSummary: 3-5 concise bullets of the day\'s key site activities.\n' +
    '- sectionBreakdown: work completed, grouped by Area/Section.\n' +
    '- rtoVsAisDiscrepancies: locations/items where RTO and AIS disagree or are ' +
    'unverified (differing quantities, work reported by only one source, conflicting ' +
    'status). Empty array if fully aligned.\n' +
    '- manpowerAndRemarks: key manpower, equipment, safety/quality highlights.\n' +
    'Call emit_summary once.\n\n' +
    '=== RTO NOTES ===\n' + (rtoText || '(none)') +
    '\n\n=== AIS DAILY REPORT ===\n' + (aisText || '(none)');

  var body = {
    model: getModel_(),
    max_tokens: 4096,
    output_config: { effort: 'low' },
    tools: [tool],
    tool_choice: { type: 'tool', name: 'emit_summary' },
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
  if (!raw) throw new Error('No summary returned');
  return normalizeSummary_(raw, 'ai');
}

/** Coerce any summary object into the canonical shape the app/viewer expect. */
function normalizeSummary_(raw, source) {
  raw = raw || {};
  function arr(v) { return Array.isArray(v) ? v : []; }
  function str(v) { return String(v == null ? '' : v).trim(); }

  var discrepancies = arr(raw.rtoVsAisDiscrepancies).map(function (d) {
    return { item: str(d.item), rto: str(d.rto), ais: str(d.ais),
             severity: (str(d.severity) || 'medium').toLowerCase() };
  }).filter(function (d) { return d.item || d.rto || d.ais; });

  return {
    date: normalizeDate_(raw.date) || str(raw.date),
    status: discrepancies.length ? 'Discrepancy' : 'Aligned',
    executiveSummary: arr(raw.executiveSummary).map(str).filter(Boolean).slice(0, 6),
    sectionBreakdown: arr(raw.sectionBreakdown).map(function (s) {
      return { area: str(s.area), section: str(s.section), work: str(s.work) };
    }).filter(function (s) { return s.section || s.work; }),
    discrepancies: discrepancies,
    manpowerAndRemarks: arr(raw.manpowerAndRemarks).map(str).filter(Boolean),
    source: source || 'ai'
  };
}

/**
 * Deterministic fallback: build the same summary shape from the parsed records
 * and their comparison — no AI, always available.
 */
function summaryFromRecords_(rtoText, aisText) {
  var rto = parseWhatsApp(rtoText, 'RTO');
  var ais = parseWhatsApp(aisText, 'AIS');
  var cmp = compareRecords(rto, ais);
  var rows = cmp.rows, o = cmp.overall;

  var date = mostCommonDate_(rto.concat(ais));

  var areasActive = uniqueValues_(rows.map(function (r) { return r.areaGroup; }).filter(Boolean));
  var exec = [
    o.total + ' site location' + (o.total === 1 ? '' : 's') + ' reported across ' +
      (areasActive.length ? areasActive.sort().join(', ') : 'site') + '.',
    o.matched + ' aligned, ' + o.conflicts + ' with discrepancies, ' + o.missing +
      ' reported by only one source.',
    'RTO vs AIS accuracy ' + o.accuracyPct + '% for the day.'
  ];

  var sectionBreakdown = rows.map(function (r) {
    return { area: r.areaGroup || '', section: r.area,
             work: r.rtoActivity || r.samsungActivity || '' };
  });

  var discrepancies = rows.filter(function (r) { return r.status !== 'Match'; })
    .map(function (r) {
      return {
        item: (r.areaGroup ? r.areaGroup + ' · ' : '') + r.area,
        rto: r.rtoActivity || (r.status === 'MissingRTO' ? '(not reported by RTO)' : ''),
        ais: r.samsungActivity || (r.status === 'MissingSamsung' ? '(not reported by AIS)' : ''),
        severity: r.status === 'Conflict' ? 'medium' : 'high'
      };
    });

  var manpower = [];
  rto.concat(ais).forEach(function (r) {
    if (/manpower|pax|crane|excavat|delivery|safety/i.test(r.remark + ' ' + r.activity)) {
      var note = (r.area ? r.area + ': ' : '') + (r.remark || r.activity);
      if (note && manpower.indexOf(note) === -1) manpower.push(note);
    }
  });

  return {
    date: date,
    status: discrepancies.length ? 'Discrepancy' : 'Aligned',
    executiveSummary: exec,
    sectionBreakdown: sectionBreakdown,
    discrepancies: discrepancies,
    manpowerAndRemarks: manpower.slice(0, 8),
    source: 'fallback'
  };
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

function uniqueValues_(list) {
  var seen = {}, out = [];
  list.forEach(function (v) { if (!seen[v]) { seen[v] = 1; out.push(v); } });
  return out;
}

// Export for the Node test harness (ignored by Apps Script).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeExtracted_: normalizeExtracted_,
    normalizeSummary_: normalizeSummary_,
    summaryFromRecords_: summaryFromRecords_,
    generateWorkSummary: generateWorkSummary
  };
}
