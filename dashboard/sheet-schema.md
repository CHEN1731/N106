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
| `activity` | Text | merged work description (keep any `X/Y m³` figure here) |
| `manpower` | Number | manpower for this activity |
| `stage` | Text | construction stage: Guide Wall / Excavation / Rebar Cage / Concrete Casting / Trimming / Breaking / Completed / Other |

The AI applies strict **inclusion/exclusion** filtering and **groups by Area**
(see `gas/Extract.gs` `PRODUCTIVITY_SYSTEM`) and links each activity to its
`element_id`. The flattened Activities rows are the **single source of truth**: the
Viewer derives each Area's KPI breakdown (DW/BP/BT/CW counts + ID lists, concrete m³,
manpower) *from these rows*, so clicking a KPI back-checks straight to the activities
behind it. All fields are editable per-row in the Viewer (＋ Add / ✎ Edit / 🗑 Delete).

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

## Tab: `DailySummaries` — Resource & Production view (Machine / Excavation / RC)

Written by `saveToSheet` (same upsert-by-date as the other tabs). Holds the three
Resource & Production pillars for each date: the two heavy-machinery families, excavation
zones, and reinforced-concrete work. The nested nodes are **JSON-stringified** into three
columns so the shape can grow without schema churn; a few flat numbers sit alongside for
quick reading. This is a **new tab** — the `Activities`/`Productivity` tabs are untouched.

| Column | Type | Notes |
|--------|------|-------|
| `date` | Date (yyyy-mm-dd) | upsert key |
| `total_concrete_m3` | Number | total concrete cast (m³) — mirrors RC total |
| `total_loads` | Number | total soil-disposal loads for the day |
| `active_cutters` | Number | BC Cutters not Idle (Active + Maintenance) |
| `active_rigs` | Number | Boring Rigs not Idle |
| `machine_status_json` | Text (JSON) | `{bcCutters:[{assignedId,location,status,evidence}], boringRigs:[…]}` — `status` ∈ Active/Completed/Maintenance |
| `excavation_json` | Text (JSON) | `{totalVolumeOrLoads, activeExcavations:[{location,currentDepth,activity}]}` |
| `rc_json` | Text (JSON) | `{totalConcreteVolumeM3, rcActivities:[{location,type,activity}]}` — `type` ∈ Rebar/Concreting/Formwork |

Machine detection is **strict** (see `gas/Extract.gs` `PRODUCTIVITY_SYSTEM` rule 8, enforced
by `normalizeMachineStatus_`): a **BC Cutter** is logged only for a DW/BT/CW mentioned with
**"bite"**; a **Boring Rig** only for a BP/pile mentioned with **"depth"** (current/drilling
depth). `status` is **Completed** when casting is mentioned, **Maintenance** on
breakdown/hose-change, else **Active**; `evidence` holds the trigger snippet. The Viewer leads with a **Site Machine
Layout** banner that groups the detected machines by `location`; the Excavation Tracker, RC
section, Area KPIs, charts, and activity table follow.

## Tab: `Raw_Logs` — inbound WhatsApp Cloud API audit (full-automation path)

Written by `doPost` in `gas/Webhook.gs` whenever the WhatsApp Business (Meta Cloud)
API delivers a message. **Append-only** (never upserted or wiped) so every raw
message is auditable. A time-driven trigger (`processRawLogs`) later rebuilds each
affected day's summary from these rows.

| Column | Type | Notes |
|--------|------|-------|
| `received_at` | Date-time | server time the webhook row was appended |
| `wa_message_id` | Text | WhatsApp message id (used to de-dupe on rebuild) |
| `from_phone` | Text | sender's WhatsApp number |
| `sender_name` | Text | sender's WhatsApp profile name |
| `source` | Text | `RTO` or `AIS`, from the `WHATSAPP_SOURCE_MAP` phone map (default `RTO`) |
| `msg_date` | Text (yyyy-mm-dd) | message date, from `wa_timestamp` in the project timezone |
| `wa_timestamp` | Text | raw unix timestamp (seconds) from Meta |
| `type` | Text | `text`, `image`, `button`, … (non-text logged for audit) |
| `text` | Text | message body (empty for non-text) |
| `processed` | Boolean | `FALSE` until `processRawLogs` has rebuilt that day's summary |

**Data flow:** `WhatsApp Cloud API → doPost → Raw_Logs → processRawLogs (hourly) →
saveToSheet(generateProductivity(rto, ais, date)) → Activities + Productivity`. The
Viewer is unchanged — it still reads only `Activities` + `Productivity`. Rebuilds are
idempotent: `saveToSheet` upserts by date, so re-processing a day is safe. The manual
uploader remains as an offline/fallback path that writes the same two tabs.
