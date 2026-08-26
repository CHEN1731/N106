/**
 * Compare.gs — match RTO vs Samsung records and score accuracy.
 *
 * Match key = Date + Area/Section (normalised). For each key:
 *   - present both sides & details agree  -> "Match"
 *   - present both sides & details differ -> "Conflict"
 *   - present RTO only                    -> "MissingSamsung"
 *   - present Samsung only                -> "MissingRTO"
 *
 * Accuracy % = Matches / total distinct keys.
 *
 * Pure logic; runs in GAS and in the Node test harness.
 */

var COMPARE_CONFIG = {
  // Two records "agree" when the token overlap of Activity(+Remark) is >= this.
  // Kept lenient because free-form messages paraphrase the same work heavily;
  // the match key (Date + Area) already establishes they are the same record,
  // so a differing quantity (numbersConflict_) is the primary Conflict signal.
  agreeThreshold: 0.5,
  // Weight of activity vs remark when scoring similarity.
  activityWeight: 0.7,
  remarkWeight: 0.3
};

/**
 * @param {Array<Object>} rtoRecords
 * @param {Array<Object>} samsungRecords
 * @return {{rows: Array<Object>, daily: Array<Object>, overall: Object}}
 */
function compareRecords(rtoRecords, samsungRecords) {
  var rtoMap = indexByKey_(rtoRecords);
  var samMap = indexByKey_(samsungRecords);

  var keys = unionKeys_(rtoMap, samMap);
  var rows = [];

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var r = rtoMap[key];
    var s = samMap[key];
    var parts = key.split('||');
    var row = {
      date: parts[0],
      // Display the original-cased area from whichever side has the record.
      area: (r && r.area) || (s && s.area) || parts[1],
      status: '',
      similarity: 0,
      rtoActivity: r ? r.activity : '',
      samsungActivity: s ? s.activity : '',
      rtoRemark: r ? r.remark : '',
      samsungRemark: s ? s.remark : '',
      rtoPhotos: r ? r.photos : 0,
      samsungPhotos: s ? s.photos : 0
    };

    if (r && s) {
      var sim = recordSimilarity_(r, s);
      row.similarity = Math.round(sim * 100) / 100;
      // A quantity mismatch is always a conflict, even when the wording is
      // otherwise identical — differing numbers are the point of the check.
      var numConflict = numbersConflict_(r, s);
      row.status = (!numConflict && sim >= COMPARE_CONFIG.agreeThreshold)
        ? 'Match' : 'Conflict';
    } else if (r && !s) {
      row.status = 'MissingSamsung';
    } else {
      row.status = 'MissingRTO';
    }
    rows.push(row);
  }

  rows.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.area < b.area ? -1 : (a.area > b.area ? 1 : 0);
  });

  var daily = summariseByDay_(rows);
  var overall = summariseOverall_(rows);
  return { rows: rows, daily: daily, overall: overall };
}

function indexByKey_(records) {
  var map = {};
  for (var i = 0; i < records.length; i++) {
    var rec = records[i];
    var key = keyFor_(rec);
    if (!key) continue;
    if (map[key]) {
      // Same day+area reported twice on one side: keep the richer remark and
      // sum photos rather than dropping data.
      map[key].remark = [map[key].remark, rec.remark].filter(Boolean).join(' | ');
      map[key].photos += rec.photos;
      if (!map[key].activity) map[key].activity = rec.activity;
    } else {
      map[key] = {
        source: rec.source, date: rec.date, area: rec.area,
        activity: rec.activity, remark: rec.remark, photos: rec.photos
      };
    }
  }
  return map;
}

function keyFor_(rec) {
  if (!rec.date || !rec.area) return '';
  return normKey_(rec.date) + '||' + normKey_(rec.area);
}

function normKey_(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

function unionKeys_(a, b) {
  var seen = {};
  var keys = [];
  [a, b].forEach(function (map) {
    for (var k in map) if (!seen[k]) { seen[k] = true; keys.push(k); }
  });
  return keys;
}

/** Weighted token-overlap similarity of two records' activity + remark. */
function recordSimilarity_(r, s) {
  var act = jaccard_(tokens_(r.activity), tokens_(s.activity));
  var rem = jaccard_(tokens_(r.remark), tokens_(s.remark));
  // If neither side has a remark, judge on activity alone.
  if (!r.remark && !s.remark) return act;
  return COMPARE_CONFIG.activityWeight * act + COMPARE_CONFIG.remarkWeight * rem;
}

/** True when both records cite numbers and the number sets differ. */
function numbersConflict_(r, s) {
  var a = numbers_(r.activity + ' ' + r.remark);
  var b = numbers_(s.activity + ' ' + s.remark);
  if (!a.length || !b.length) return false;
  return a.join(',') !== b.join(',');
}

function numbers_(text) {
  var m = String(text || '').match(/\d+(?:\.\d+)?/g);
  if (!m) return [];
  return m.map(function (n) { return parseFloat(n); })
          .sort(function (x, y) { return x - y; });
}

function tokens_(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(function (t) { return t.length > 1; });
}

function jaccard_(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  var setA = {}, inter = 0, union = 0;
  a.forEach(function (t) { setA[t] = true; });
  var setB = {};
  b.forEach(function (t) { setB[t] = true; });
  for (var t in setA) { union++; if (setB[t]) inter++; }
  for (var u in setB) { if (!setA[u]) union++; }
  return union === 0 ? 0 : inter / union;
}

function summariseByDay_(rows) {
  var byDate = {};
  rows.forEach(function (row) {
    var d = byDate[row.date] || (byDate[row.date] = {
      date: row.date, total: 0, matched: 0, conflicts: 0, missing: 0
    });
    d.total++;
    if (row.status === 'Match') d.matched++;
    else if (row.status === 'Conflict') d.conflicts++;
    else d.missing++;
  });
  return Object.keys(byDate).sort().map(function (d) {
    var o = byDate[d];
    o.accuracyPct = o.total ? Math.round((o.matched / o.total) * 1000) / 10 : 0;
    return o;
  });
}

function summariseOverall_(rows) {
  var o = { total: rows.length, matched: 0, conflicts: 0, missing: 0 };
  rows.forEach(function (row) {
    if (row.status === 'Match') o.matched++;
    else if (row.status === 'Conflict') o.conflicts++;
    else o.missing++;
  });
  o.accuracyPct = o.total ? Math.round((o.matched / o.total) * 1000) / 10 : 0;
  return o;
}

// Export for Node test harness (ignored by Apps Script).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    compareRecords: compareRecords,
    recordSimilarity_: recordSimilarity_,
    COMPARE_CONFIG: COMPARE_CONFIG
  };
}
