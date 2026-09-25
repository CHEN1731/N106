# N106 — WhatsApp Site Record Accuracy Dashboard

Daily site work record accuracy checker for project **N106**.

Two site teams — **RTO** and **Samsung** — report the same daily site activities
in separate WhatsApp groups. This project loads both exports, checks that the same
record appears on both sides with matching detail, and publishes a director-facing
dashboard.

## The three pieces

```
   ┌────────────────────┐      ┌──────────────────┐      ┌────────────────────────┐
   │  GAS Web App (you) │  →   │  Google Sheet    │  →   │  Interactive Viewer    │
   │  upload / compare  │      │  Records /       │      │  ?page=view (in the    │
   │  AI-extract / save │      │  Comparison /    │      │  same app) — directors │
   │                    │      │  DailySummary    │      │  filter / drill / edit │
   └────────────────────┘      └──────────────────┘      └────────────────────────┘
                                        │
                                        └──→ (optional) Looker Studio dashboard
```

1. **`gas/` — Apps Script web app (you, the uploader).**
   Left pane: paste/upload the **RTO** WhatsApp export (`.txt`). Right pane: upload
   the **AIS Daily Report** as a **Word `.docx`** (unzipped to editable text **in the
   browser** via JSZip — any file size, images ignored; `Docx.gs` is a server-side
   fallback) or paste text. Both are editable and fully shown. Click
   **Compare** — messages/report are turned into clean records by
   **AI extraction (Claude)** when an API key is set, otherwise by the built-in
   regex parser — records are matched on **Date + Section/segment** and scored;
   click **Save to Sheet** to write the three tabs.

2. **Google Sheet — the data bridge.** Schema in
   [`dashboard/sheet-schema.md`](dashboard/sheet-schema.md).

3. **Productivity & Summary Dashboard (director & team) — the same web app at
   `?page=view`.** Reads the Sheet live and is organised into **clickable tab pages**
   — **Overview** (total manpower + the concrete-volume, active-structures and
   by-stage charts), **ERSS** (Machine Status & Element Lifecycle — the detected machine
   data only), **Excavation** (the Tunnel/FB soil-volume tracker),
   **Reinforced Concrete** (concrete m³ + RC activities), and **All Activities** (the
   DW/BP/BT/CW KPI cards + the full merged-activities breakdown, kept separate from the
   ERSS machine data). The **From/To date
   range** (blank = all dates), Area and search filters stay pinned above the tabs and
   apply to every page; the chosen tab is remembered between visits.
   Activities are fully editable in the Viewer: **✎ Edit**, **🗑 Delete**, and
   **＋ Add activity** all write straight back to the `Activities` tab (and keep
   the day's manpower KPI in sync), so corrections are stored permanently.

## What the AI does

The two reports (RTO + AIS) are sent to Claude with a strict Lead-Site-Engineer
**system prompt** (`PRODUCTIVITY_SYSTEM` in `gas/Extract.gs`) that applies explicit
**inclusion rules** (physical progress: drilling, excavation, concreting, casting,
grouting…, plus volume/depth/load/manpower metrics) and **exclusion rules** (drops
noise: "No activity", housekeeping/cleaning, generic prep, "waiting for…",
maintenance — unless it blocks the critical path). It **merges and de-duplicates**
the activities (one unified entry per element, e.g. `DW1547`), **groups them by Area
(Area 1–4 / Others)**, and links each to its **elementId**. Output is a forced-JSON
tool call with per-area **kpiBreakdown** (active DW/BP/BT/CW ID-lists + counts,
concrete m³, manpower) and **grandTotals**:

```
{ date,
  areas:[ { areaName, kpiBreakdown:{ activeDWalls[],dWallCount, activeBoredPiles[],bPileCount,
              activeButtressWalls[],bWallCount, activeCrossWalls[],cWallCount,
              concreteVolumeM3, areaManpower },
            activities:[{ elementId, section, activityDescription, manpower }] } ],
  grandTotals:{ totalConcreteVolumeM3, totalManpower } }
```

The Viewer lays the dashboard out **per Area**; each area shows its KPI as
**clickable badges** — click "2 DW" to instantly filter that area's activity table
to the matching `elementId`s (a "back-check"). KPI numbers are derived from the
stored activity rows, so they always reconcile.

Each activity is also tagged with a **construction stage** (Guide Wall → Excavation →
Rebar Cage → Concrete Casting → Trimming → Breaking → Completed, else Other). A
**stage-breakdown chart** shows how many **distinct elements** sit at each stage
(each element counted once at its *furthest* stage), stacked by structure type
(DW/BP/BT/CW) and honouring the Date-range + Area filters. Stage is editable per row.

### Resource & Production view (Machine / Excavation / RC)

The same AI call also returns three **Resource & Production** nodes, and the Viewer leads
with them (the Area KPIs, charts, and activity table stay below):

```
{ machineStatus:{ bcCutters:[{machineId,area,location,machineState,workingOnElements:[{elementId,lifecycleStage,depth}],evidence}], boringRigs:[…] },  // machineState ∈ Active|Maintenance|Idle · lifecycleStage ∈ Excavation|Rebar|Concreting|Completed · depth = metres (or null)
  excavation:{ totalVolumeOrLoads, activeExcavations:[{location,currentDepth,activity}] },
  reinforcedConcrete:{ totalConcreteVolumeM3, rcActivities:[{location,type,activity}] } }  // type ∈ Rebar|Concreting|Formwork
```

- **Machine Status & Element Lifecycle** (top KPI cards) — the machine and element tracking
  are **one unified workflow**. The fleet is at most **6 BC Cutters + 4 Boring Rigs** (a hard
  cap — never exceeded); only machines actually working are shown (fewer than 6/4 is fine, no
  idle padding). Cards are **grouped under Area headings** (Area 1 → 4) — a machine is
  auto-assigned to whichever Area its work is in and **never mixes two Areas on one card**; when
  more location-groups appear in an Area than the fleet allows, same-Area cards **merge** (a
  machine finished one element and moved to the next). Each card's **header** shows `machineId`
  and a **machineState** badge (green Active / red Maintenance / grey Idle). The card **body**
  lists every element that machine worked today as **📌 `elementId` · `location` · `depth` m ➔
  [lifecycle badge]** (amber Excavation / blue Rebar / orange Concreting / green Completed) —
  each element carries **its own** location and depth, parsed from its report line; within one
  card an element at *Completed* and one at *Excavation* can appear together. An element is
  logged (and counted) only when its own text has its machine trigger — **bite** for a
  BC Cutter (DW/BT/CW) or **depth** for a Boring Rig (BP). **Rebar cage / casting are NOT
  triggers** — an element with only rebar cage or casting (no bite/depth) is not shown or
  counted; they only refine the stage of an element already logged via bite/depth.
  On Save, one loop writes both
  a **`DailyMachineLogs`** row per machine (daily fleet state) and a **forward-only**
  **`ElementTracker`** upsert per element (the cross-day lifecycle DB the cards read for each
  element's *tracked* stage).
- **Excavation Tracker** — a **static soil-volume tracker** (m³) for the whole **Tunnel +
  Facility Building**, mirroring the site team's own spreadsheet: per-zone **Planned /
  Cumulative / Remaining / % Progress** (with a bar) + a TOTAL row. The figures live in the
  user-maintained **`ExcavationProgress`** tab (auto-created & seeded on first Save); update
  them there or paste from your sheet. A muted subline shows what the range's reports imply
  (`N loads × LOADS_TO_M3`, Script Property, default 6) — informational, not the official
  cumulative. (Per-element depth moved from here into the machine cards, above.) Below the
  tracker, a **Daily / Weekly / Monthly** toggle shows a **stacked bar chart + table** of soil
  excavated per period per zone — from the user-maintained **`ExcavationDaily`** tab
  (date · zone · m³), falling back to the reported loads×factor for any unlogged day.
- **Reinforced Concrete** — a prominent total-m³ KPI plus RC activities with type-coloured
  badges (blue Rebar / orange Formwork / grey Concreting).

These are stored per date in the `DailySummaries` tab (three JSON columns + flat totals);
they are **read-only** in the Viewer for now. When no API key is set, the offline fallback
derives them deterministically from the parsed activities.

### Concrete volume rule (`castVolumeOf_` in `gas/Extract.gs`, mirrored in the Viewer)

Concrete counts **completed casting only**:
- **LSS material backfilling** (and any backfilling) is **not** concrete casting — its
  volume is excluded.
- A reading written **`X/Y m³`** means `Y` is the panel total and `X` is the current
  cast — only `X` is counted.
- Each panel is counted **once**; if the same panel is reported several times, the
  **latest / highest** cast is used (e.g. `40/100` then `100/100` → **100**, not 140).
- A plain `N m³` counts only in a casting context (cast / concreting / pour); mixing,
  soil or backfill volumes are ignored.
Area concrete = Σ(each panel's single latest cast); grand total = Σ areas.

Without an API key a **deterministic fallback** (`productivityFromRecords_` in
`gas/Extract.gs`) parses the WhatsApp side and regex-extracts the same metrics, so
the app always produces a result (a `.docx` AIS report still needs the AI path).

## Repository layout

```
gas/                 Apps Script project (clasp-compatible)
  appsscript.json    manifest (web app + external_request scope)
  Code.gs            doGet routing + runComparison + saveToSheet + getReport (Activities/Productivity tabs)
  Docx.gs            read an uploaded AIS Word (.docx) report into text (Utilities.unzip)
  Extract.gs         AI merge+metrics (Claude via UrlFetchApp) + deterministic fallback
  Parser.gs          WhatsApp .txt -> records  (CONFIG block at top to tune)
  Compare.gs         (legacy) record-matching utility, no longer used by the app
  Webhook.gs         WhatsApp Cloud API: doPost logger + processRawLogs batch rebuild
  Index.html         uploader: two editable panes + productivity preview (+Styles/JavaScript)
  Viewer.html        Dashboard: Resource & Production (Machine/Excavation/RC) + Area KPIs + charts + activity list (+ViewerStyles/ViewerJs)
docs/
  report-template.md     recommended message format for the site teams
dashboard/
  sheet-schema.md        exact tabs/columns
  looker-setup-guide.md  optional Looker build
  preview.html           self-contained viewer/dashboard mockup
samples/             example exports (rto / samsung)
test/run-tests.js    Node harness validating parser + productivity extraction
```

## Run the tests

The parsing/comparison logic is plain JS, so it runs under Node as well as in GAS:

```
npm test        # or: node test/run-tests.js
```

## Deploy the web app

Option A — **paste into the editor**: open <https://script.google.com> → New
project → create files matching `gas/` → paste each file's contents → **Deploy →
New deployment → Web app** (execute as *you*, access *only myself*).

Option B — **clasp** (recommended, keeps the repo in sync):

```
npm i -g @google/clasp
clasp login
clasp create --type webapp --title "N106 Accuracy" --rootDir ./gas
clasp push
clasp deploy
```

Then either bind the script to a Google Sheet, or set `SPREADSHEET_ID` at the top
of `Code.gs` to the target spreadsheet's ID.

**Two URLs from one deployment:**
- **Uploader (you):** the web-app URL as-is.
- **Viewer (directors):** the same URL with **`?page=view`** appended.

## AI extraction (optional but recommended)

The app cleans messy messages with **Claude** when a key is present, and silently
falls back to the regex parser otherwise. To enable it:

1. Apps Script → **Project Settings → Script properties** → add
   **`ANTHROPIC_API_KEY`** = your Anthropic key. (Optional `CLAUDE_MODEL`, default
   `claude-opus-5`; set a cheaper model if you prefer. Optional **`LOADS_TO_M3`** =
   your truck loads→m³ factor, default 6, used only for the Excavation Tracker's
   "reported this range" subline.)
2. That's it — **Compare** now sends each day's messages to Claude and gets back
   clean, structured records. Cost is a few cents/day; a failed call or missing key
   just uses the parser, so the app always works.

The logic lives in [`gas/Extract.gs`](gas/Extract.gs) (`extractRecords` → Claude via
`UrlFetchApp`, structured tool-call output). Have the **RTO team post in the
[WhatsApp reporting template](docs/report-template.md)** — it teaches the exact trigger
words the extractor keys on (**bite / depth / rebar cage / concrete casting**, element IDs,
`X/Y m³`, loads, `pax`), so machines, element lifecycle, concrete and manpower are detected
near-perfectly with no corrections in the viewer.

Looker Studio is optional now that the built-in Viewer covers the director view;
connect it per the setup guide only if you still want it.

## Full automation via WhatsApp Cloud API (no manual upload)

Instead of pasting/uploading exports, the app can receive messages **live** from the
official **WhatsApp Business API (Meta Cloud API)** and rebuild the dashboard on a
schedule. Ingestion lives in [`gas/Webhook.gs`](gas/Webhook.gs):

```
WhatsApp Cloud API --POST--> doPost --> Raw_Logs (audit, append-only)
   hourly trigger --> processRawLogs() --> saveToSheet(generateProductivity(rto, ais, date))
      --> Activities + Productivity tabs   (the Viewer, unchanged, reads these)
```

Each inbound message is logged immediately (fast 200, so Meta doesn't retry); the
day's structured summary is rebuilt hourly from **all** of that day's raw messages,
so cross-message merging and the concrete/stage rules still apply. Rebuilds are
idempotent (upsert by date). The manual uploader stays available as an offline path.

### One-time setup

1. **Script properties** (Apps Script → Project Settings → Script properties):
   - `WHATSAPP_VERIFY_TOKEN` — any random string you choose (also entered in Meta's UI).
   - `WHATSAPP_URL_TOKEN` — a second secret; append it to the callback URL as `?wt=…`
     to authenticate POSTs (Apps Script can't read Meta's `X-Hub-Signature-256` header,
     so a URL token is used instead). Optional in dev; recommended in production.
   - `WHATSAPP_SOURCE_MAP` — JSON mapping each sender phone to a source, e.g.
     `{"60123456789":"RTO","60198887777":"AIS"}`. Unmapped senders default to `RTO`.
   - `ANTHROPIC_API_KEY` — as before (used by the rebuild).
2. **Deploy → New deployment → Web app**: execute as *me*, access **Anyone**
   (required — Meta calls the URL anonymously). This access level is set here in the
   Deploy dialog, **not** in `appsscript.json` (the manifest stays `MYSELF` so the repo
   doesn't ship a public default). Copy the `/exec` URL.
3. In the Apps Script editor, run **`installWebhookTrigger_`** once (authorise scopes
   when prompted) — this creates the hourly `processRawLogs` trigger.

> ⚠️ Access **Anyone** makes the uploader/Viewer reachable by anyone who has the
> (unguessable) `/exec` URL. The POST path is guarded by `WHATSAPP_URL_TOKEN`; if you
> also need the Viewer itself private, add a `?key=` gate to `doGet` (not included).

### Register the webhook in the Meta Developer Portal

1. Meta App → **WhatsApp → Configuration → Webhook → Edit**.
2. **Callback URL** = your `/exec` URL **with the token**, e.g.
   `https://script.google.com/macros/s/XXXX/exec?wt=YOUR_URL_TOKEN`.
3. **Verify token** = the `WHATSAPP_VERIFY_TOKEN` you set. Click **Verify and save** —
   Meta GETs the URL and the app echoes `hub.challenge` (handled by `handleWebhookGet_`,
   which the existing `doGet` calls first).
4. Under **Webhook fields**, **Subscribe** to **`messages`**.
5. Send a test WhatsApp message to your business number → a row appears in `Raw_Logs`.
   Run **`debugProcessRawLogs`** (or wait for the hourly trigger) → open the Viewer
   (`?page=view`) and confirm the day shows.

Notes: the Cloud API delivers **text**; media (images) arrive as IDs that need a
separate Graph API fetch, so they're logged for audit but not downloaded (same caveat
as the manual media-export flow). Non-text messages are recorded in `Raw_Logs` with an
empty body.

## Daily workflow (sustainable, accumulates history)

Run it every day; nothing gets overwritten:

1. Upload that day's **RTO** WhatsApp export (the full-history `.txt` is fine) and the
   **AIS** `.docx`.
2. Pick the **Report date** (top-right). The app scopes the RTO chat to that date
   (so a whole-chat export compares cleanly against the single-day AIS report, and
   the AI only processes that day). Leave it blank to auto-use the AIS report's date.
3. **Compare**, review, **Save to Sheet**.

**Save to Sheet upserts by date** — the day's rows replace only that date in every
tab (`Records`, `Comparison`, `DailySummary`, `WorkSummary`) and keep all other
days, so the Viewer's trend, filters, and executive-summary history build up over
time. Re-uploading a day corrects just that day (`mergeByDate_` in `gas/Code.gs`).
The Viewer (`?page=view`) then shows the full multi-day history.

## Executive Work Summary (RTO vs AIS)

On **Compare**, the app also cross-compares the **RTO** field notes against the
**AIS Daily Report** (the two uploaded texts) and produces a management summary:
an **executive summary** (3–5 bullets), **work by section** (Area 1–4), the
**RTO-vs-AIS discrepancies** (with severity), and **manpower/quality highlights**,
plus an overall **Aligned / Discrepancy** status. Claude generates it when an API
key is set; otherwise a **deterministic fallback** builds the same shape from the
parsed records — so it always produces a summary.

**Save to Sheet** upserts it (one row per date, history kept) to the `WorkSummary`
tab (`gas/Code.gs#upsertWorkSummary_`; schema in
[`dashboard/sheet-schema.md`](dashboard/sheet-schema.md)). The directors' Viewer
(`?page=view`) shows it as the **Executive Work Summary (工作总结看板)** panel at the
top, driven by the Date / Area / Section filters. Logic lives in
[`gas/Extract.gs`](gas/Extract.gs) (`generateWorkSummary` → `callClaudeSummary_`
with `summaryFromRecords_` fallback).

## Removing unwanted rows (chatter, questions, non-reports)

You never delete rows by hand. **Save to Sheet rewrites the `Records`, `Comparison`
and `DailySummary` tabs from scratch every time** (`writeTable_` clears the tab first),
so the fastest cleanup is:

1. The parser now runs with **`requireLocator: true`** — only messages carrying a real
   `Sec-/segment` locator are kept, so greetings, RFI questions, emoji and coordination
   chatter are dropped *before* they reach the Sheet.
2. Re-open the app, **Compare** the same exports again, and **Save to Sheet**. The old
   junk rows are overwritten and gone. In Looker Studio, click **Refresh data**.

If a specific junk phrase still slips through, add it to `chatterPatterns` in
`gas/Parser.gs` (or, if it lacks a locator, `requireLocator` already removes it). To keep
`General`-bucket notes instead of dropping them, set `requireLocator: false`.

## Tuning the parser to your real exports

`gas/Parser.gs` opens with a clearly-marked **`PARSER_CONFIG`** block — adjust it to
your exports, no logic changes needed:

- **`locator.segments`** — the main thing to edit: the site-plan segment codes
  (`Mb`, `Ub`, `Ld`, `Ta`, …) plus recurring sub-locations (`Cube8`, `SLF`, `SJII`,
  `XR14`, `TLQ`, `OPA`, …). Add/trim to match your plan labels.
- **`locator.segmentPatterns`** — regexes that recognise structure/pile/shaft codes
  as segments without listing thousands (`P323`, `DW1072`, `EI12`, `BT29-1`, `MH02`,
  `T9-3`, `CW319`). Extend to your numbering.
- **`locator.sectionRe`** — how the Section is written (default matches `Sec-C`,
  `Sec C`, `Section C`).
- **`locator.segmentArea`** — the map from each segment/named location to its **Area 1–4**
  group (e.g. `{ 'Mb': 'Area 2', 'Le': 'Area 2', 'ER15': 'Area 2' }`). This site-plan map is
  **authoritative**: when a locator resolves here (incl. sub-numbered forms like `Le2 → Le`),
  it **overrides the AI's guessed Area** everywhere — activity KPIs and the machine cards — so
  a location like `ER15(Le)` always reads Area 2 even if the model mislabelled it. Add named
  locations here to fix any mis-grouping. Unmapped segments leave `area_group` blank.
- **`requireLocator`** — `true` (recommended): keep ONLY messages with a real
  `Sec-/segment` locator, so greetings, questions (RFI), emoji and coordination
  chatter never reach the Sheet. Set `false` to also keep `General`-bucket notes.
- **`activityKeywords`** — words that mark a no-locator message as real site content
  (only used when `requireLocator` is `false`).
- **`chatterPatterns`** — greetings/acks/questions/emoji to skip.
- **`areas`** — optional generic name/alias fallback for non-N106 reuse (empty by
  default).
- **`labels`** — optional `Date:`/`Area:`/`Activity:`/`Remark:` synonyms; a labelled
  message uses those over the heuristics (hybrid).
- **`lineFormats`** — WhatsApp export headers (iOS / Android), auto-detected.

Comparison lives in `gas/Compare.gs`: `COMPARE_CONFIG.agreeThreshold` (text-similarity
bar) and `QUANTITY_RE` (which units count as a quantity). A **quantity** mismatch
(e.g. `7pax` vs `9pax`, `25 m3` vs `30 m3`) is always a Conflict; bare identifiers
like `DW64`, `ER15` or chainage `CH 0+498` are ignored so they never false-flag.

The sample files under `samples/` hold real N106-format lines — replace with your own
and re-run `npm test`.
