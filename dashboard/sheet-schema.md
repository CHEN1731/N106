# Google Sheet schema — Productivity & Summary Dashboard

The GAS web app writes these tabs on **Save to Sheet**. Both tabs **upsert by
date** — a day's upload replaces only that date's rows and keeps every other day,
so history accumulates for the charts. The Viewer (`?page=view`) reads them.

## Tab: `Activities`

One row per **merged** activity (RTO + AIS combined and de-duplicated).

| Column | Type | Notes |
|--------|------|-------|
| `date` | Date (yyyy-mm-dd) | report date (upsert key) |
| `area` | Text | `Area 1`–`Area 4` or `Others` |
| `section` | Text | section / segment / location, e.g. `Sec-C/Mb` |
| `element_id` | Text | structural element ID, e.g. `DW1547`, `BP-T9-3` (or blank) |
| `activity` | Text | merged work description |
| `manpower` | Number | manpower for this activity |
| `source_evidence` | Text | original verbatim snippet, for back-checking |

The AI applies strict **inclusion/exclusion** filtering and **groups by Area**
(see `gas/Extract.gs` `PRODUCTIVITY_SYSTEM`), links each activity to its
`element_id`, and records the `source_evidence` snippet. The flattened Activities
rows are the **single source of truth**: the Viewer derives each Area's KPI
breakdown (DW/BP/BT/CW counts + ID lists, concrete m³, manpower) *from these rows*,
so clicking a KPI back-checks straight to the activities behind it. All fields are
editable per-row in the Viewer (＋ Add / ✎ Edit / 🗑 Delete).

## Tab: `Productivity` — one row per date (drives the charts)

| Column | Type | Notes |
|--------|------|-------|
| `date` | Date (yyyy-mm-dd) | upsert key |
| `dwall_count` | Number | # Diaphragm Walls active |
| `bpile_count` | Number | # Bored Piles active |
| `bwall_count` | Number | # Buttress Walls active |
| `cwall_count` | Number | # Cross Walls active |
| `concrete_m3` | Number | total concrete cast (m³) |
| `total_manpower` | Number | total manpower (deduped) |
| `active_dwalls` | Text | comma-separated DW IDs (e.g. `DW1547, DW04`) |
| `active_bpiles` | Text | comma-separated BP IDs |
| `active_bwalls` | Text | comma-separated BT IDs |
| `active_crosswalls` | Text | comma-separated CW IDs |

The Viewer builds: the **7-day concrete bar chart** from the last 7 `Productivity`
rows' `concrete_m3`; the **DW/BP/BT/CW doughnut** and **KPI cards** from the
selected date's row; and the **activities list** (filterable by Area) from
`Activities`.
