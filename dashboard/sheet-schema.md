# Google Sheet schema — the Looker Studio data source

The GAS web app writes these three tabs on **Save to Sheet**. Each tab is fully
rewritten every save (header row frozen + bold). Looker Studio connects to this
spreadsheet and reads these tabs as data sources.

> Column names below are the exact header text the app writes — match them when
> you set field types in Looker.

## Tab: `Records`

One row per parsed record (both sources combined). Feeds record counts and the
raw activity feed.

| Column | Type | Notes |
|--------|------|-------|
| `source` | Text | `RTO` or `Samsung` |
| `date` | Date (yyyy-mm-dd) | normalised from the message/label |
| `area_group` | Text | Area 1–4 (from the segment→area map; blank if unmapped) |
| `section` | Text | Section A–E, e.g. `Sec-C` |
| `segment` | Text | site-plan segment code, e.g. `Mb`, `Ub`, `Ld` |
| `area` | Text | the match key locator, e.g. `Sec-C/Mb` |
| `activity` | Text | extracted activity description |
| `remark` | Text | manpower / trailing notes |
| `photos` | Number | attachments credited to the record |
| `sender` | Text | WhatsApp sender name |
| `raw_ts` | Text | original date + time from the export |

## Tab: `Comparison` — primary dashboard source

One row per **distinct Date + Area key**, with both sides side by side.

| Column | Type | Notes |
|--------|------|-------|
| `date` | Date (yyyy-mm-dd) | |
| `area_group` | Text | Area 1–4 (blank if unmapped) — the higher-level filter |
| `area` | Text | match-key locator, e.g. `Sec-C/Mb` |
| `status` | Text | `Match` \| `Conflict` \| `MissingRTO` \| `MissingSamsung` |
| `similarity` | Number | 0–1 token/number similarity (blank meaning for missing) |
| `rto_activity` | Text | |
| `samsung_activity` | Text | |
| `rto_remark` | Text | |
| `samsung_remark` | Text | |
| `rto_photos` | Number | |
| `samsung_photos` | Number | |

## Tab: `DailySummary` — scorecards & trend source

One row per day. Pre-aggregated so scorecards and the trend line need no
Looker-side calc.

| Column | Type | Notes |
|--------|------|-------|
| `date` | Date (yyyy-mm-dd) | |
| `total_keys` | Number | distinct keys that day |
| `matched` | Number | status = Match |
| `conflicts` | Number | status = Conflict |
| `missing` | Number | MissingRTO + MissingSamsung |
| `accuracy_pct` | Number | matched ÷ total_keys × 100 |

## Suggested Looker calculated fields

On the `Comparison` source, add these for convenience:

- **Is Matched** = `CASE WHEN status = "Match" THEN 1 ELSE 0 END`
- **Is Conflict** = `CASE WHEN status = "Conflict" THEN 1 ELSE 0 END`
- **Is Missing** = `CASE WHEN REGEXP_MATCH(status, "^Missing.*") THEN 1 ELSE 0 END`
- **Accuracy %** (record-level agg) = `SUM(Is Matched) / COUNT(status)`
- **Status (label)** = `CASE WHEN status="MissingRTO" THEN "Missing · RTO"
  WHEN status="MissingSamsung" THEN "Missing · Samsung" ELSE status END`
