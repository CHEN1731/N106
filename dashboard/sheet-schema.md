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
| `machine_status_json` | Text (JSON) | `{bcCutters:[{machineId,area,location,machineState,workingOnElements:[{elementId,lifecycleStage,depth}],evidence}], boringRigs:[…]}` — `machineState` ∈ Active/Maintenance/Idle; `lifecycleStage` ∈ Excavation/Rebar/Concreting/Completed; `depth` = the element's dug/drilling depth in metres (number, or null) |
| `excavation_json` | Text (JSON) | `{totalVolumeOrLoads, activeExcavations:[{location,currentDepth,activity}]}` — soil-disposal loads for the day; feeds only the "reported this range" readout now (per-element depth moved into `machine_status_json`) |
| `rc_json` | Text (JSON) | `{totalConcreteVolumeM3, rcActivities:[{location,type,activity}]}` — `type` ∈ Rebar/Concreting/Formwork |

Machine detection is **strict** (see `gas/Extract.gs` `PRODUCTIVITY_SYSTEM` rule 8, enforced
by `normalizeMachineStatus_`): a **BC Cutter** is logged only for a DW/BT/CW whose text has
**"bite"**; a **Boring Rig** only for a BP/pile whose text has **"depth"**
(current/drilling/bare). **Rebar cage and casting are NOT triggers** — an element with only
rebar cage or casting (no bite/depth) is never logged on a machine; they only set the
lifecycle stage of an element already logged via bite/depth. Machines are **grouped by
`area` + `location`**, so several walls/piles done by one machine at one spot collapse into
one entry with all ids in **`assignedIds`**. `status` is **Completed** when casting is
mentioned (on a bitten element), **Maintenance** on
breakdown/hose-change, else **Active** (precedence Maintenance > Active > Completed when a
card merges several lines); `evidence` holds the trigger snippet. The Viewer leads with
**Machine Status** KPI cards — each showing type + status, an "Area · Location" badge, and the
`assignedIds` — then the Excavation Tracker, RC section, Area KPIs, charts, and activity table.
Each machine card now shows every worked element's **depth** right after its id
(`📌 DW05 · 24.1 m ➔ Excavation`), parsed from the report evidence (`parseDepthM_`).

## Tab: `ExcavationProgress` — static soil-volume tracker (Tunnel / FB)

Mirrors the site team's own Excavation Tracker spreadsheet: total excavated **soil (m³)** for
the whole Tunnel and Facility Building, by zone, as Planned vs Cumulative → % Progress. This
tab is **user-maintained** (auto-created + seeded on first Save via `ensureExcavationProgress_`,
never overwritten after) — update the numbers here or paste them from your spreadsheet. The
Viewer reads it read-only and computes Remaining + % + a TOTAL row.

| Column | Type | Notes |
|---|---|---|
| `zone` | Text | `Tunnel` / `FB` |
| `category` | Text | e.g. `Tunnel`, `FB` |
| `description` | Text | e.g. `Area 2`, `Area 4 - FB` |
| `planned_m3` | Number | planned excavation volume (m³) |
| `cumulative_m3` | Number | excavated to date (m³) — you update this |
| `updated` | Text | optional note / date of last update |

Seeded from `N106_Excavation_Tracker.xlsx`: Tunnel 53,722 / 1,178,552 m³; FB 20,882 / 171,749 m³.
A muted subline under the tracker shows what the day's/range's WhatsApp reports imply
(`N loads × LOADS_TO_M3`, a Script Property, default 6) — informational only, **not** added to
the official cumulative.

## Tab: `ExcavationDaily` — daily soil log (Daily / Weekly / Monthly view)

The per-day soil-disposal volume the Viewer rolls up into the Excavation page's
**Daily / Weekly / Monthly** chart + table. **User-maintained** (auto-created header-only via
`ensureExcavationDaily_`, never overwritten) — fill it or paste from your spreadsheet's
Daily_Log. For any date with **no** row here, the Viewer falls back to that date's reported
`N loads × LOADS_TO_M3` (shown as a grey **“Site (reported)”** series, flagged as estimated).

| Column | Type | Notes |
|---|---|---|
| `date` | Date | the excavation date |
| `zone` | Text | `Tunnel` / `FB` (free text tolerated; blank → `Site`) |
| `m3` | Number | soil excavated that day for that zone (m³) |
| `note` | Text | optional |

Weekly groups by week (Mon–Sun), Monthly by calendar month; both respect the Viewer's From/To
date range.

## Tab: `DailyMachineLogs` — one row per machine per date (Action A)

Written by `saveToSheet` in the unified machine+lifecycle loop (`saveMachinesAndElements_`),
upserted by date. A daily snapshot of the 6 BC Cutters + 4 Boring Rigs.

| Column | Type | Notes |
|--------|------|-------|
| `date` | Date (yyyy-mm-dd) | upsert key |
| `machine_id` | Text | e.g. `BC Cutter 1`, `Boring Rig 2` |
| `family` | Text | `bc` or `rig` |
| `area` | Text | Area 1–4 / Others (blank for Idle) |
| `location` | Text | site location, e.g. `ER15` |
| `machine_state` | Text | Active / Maintenance / Idle |
| `elements` | Text | the elements worked, `DW1547:Excavation@21.5m, DW04:Rebar` (`@Nm` = depth if reported) |
| `evidence` | Text | snippet justifying the log |

## Tab: `ElementTracker` — persistent element lifecycle DB (Action B)

Also written in the same loop, but **keyed by `element_id` (not by date)** and
**forward-only**: an element's `lifecycle_stage` only ever advances
(Excavation → Rebar → Concreting → Completed, via `elementStageForward_`). This is the
cross-day source of truth for where each wall/pile is; the Viewer reads it (`elementStages`)
to show each element's *tracked* stage on the machine cards.

| Column | Type | Notes |
|--------|------|-------|
| `element_id` | Text | upsert key, e.g. `DW1547`, `BP-T9-3` |
| `type` | Text | DW / BP / BT / CW (via `classifyElement_`) |
| `area` | Text | latest Area seen |
| `location` | Text | latest location seen |
| `lifecycle_stage` | Text | Excavation / Rebar / Concreting / Completed (advances only) |
| `last_machine` | Text | machine that last worked it |
| `first_seen` | Date | first date this element appeared |
| `last_updated` | Date | last date its stage changed |

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
