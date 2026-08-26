# N106 — WhatsApp Site Record Accuracy Dashboard

Daily site work record accuracy checker for project **N106**.

Two site teams — **RTO** and **Samsung** — report the same daily site activities
in separate WhatsApp groups. This project loads both exports, checks that the same
record appears on both sides with matching detail, and publishes a director-facing
dashboard.

## The three pieces

```
   ┌────────────────────┐      ┌──────────────────┐      ┌───────────────────┐
   │  GAS Web App (you) │  →   │  Google Sheet    │  →   │  Looker Studio    │
   │  upload / edit /   │      │  Records /       │      │  (Director & team │
   │  compare 2 exports │      │  Comparison /    │      │   view only)      │
   │                    │      │  DailySummary    │      │                   │
   └────────────────────┘      └──────────────────┘      └───────────────────┘
```

1. **`gas/` — Apps Script web app (you, the uploader).**
   Paste or upload the two `WhatsApp.txt` exports (RTO + Samsung). Both panes are
   **editable and fully scrollable** — nothing is anonymised. Click **Compare** to
   match records on **Date + Area/Section** and score accuracy; click **Save to
   Sheet** to write the three tabs.

2. **Google Sheet — the data bridge.** Schema in
   [`dashboard/sheet-schema.md`](dashboard/sheet-schema.md).

3. **`dashboard/` — Looker Studio dashboard (director & team, view only).**
   Build steps in [`dashboard/looker-setup-guide.md`](dashboard/looker-setup-guide.md);
   a working layout mockup in [`dashboard/preview.html`](dashboard/preview.html).

## How accuracy is judged

Messages are **free-form** (no fixed template needed). Each N106 message opens with
a locator line like `Sec-C/ER15(Mb)` or `Sec-D/CCL/Ub/Base Slab/Kian Hup:`. The
parser reads the **Section** (A–E) and the **segment code** (the site-plan labels:
`Mb`, `Ub`, `Ld`, `Ta`, …) from it and keys records on **Date + `Sec-X/Segment`**
(e.g. `2026-08-05 · Sec-C/Mb`), so RTO and Samsung line up even when the wording
differs. Messages with no recognisable locator but real site content go to a
**`General`** bucket; greetings/acknowledgements are skipped; WhatsApp's invisible
bidi marks and `~ ` sender prefix are handled. Each distinct key resolves to:

| Status | Meaning |
|--------|---------|
| **Match** | present both sides, wording agrees, no number mismatch |
| **Conflict** | present both sides but details differ (e.g. 25 m³ vs 30 m³) |
| **Missing · RTO** | reported only by Samsung |
| **Missing · Samsung** | reported only by RTO |

**Accuracy % = Matches ÷ total distinct keys**, per day and overall. Because the
same work is often paraphrased differently, the text-similarity bar is lenient —
but a difference in any cited **quantity** always counts as a Conflict, which is the
point of the check.

## Repository layout

```
gas/                 Apps Script project (clasp-compatible)
  appsscript.json    manifest (web app)
  Code.gs            doGet + runComparison + saveToSheet
  Parser.gs          WhatsApp .txt -> records  (CONFIG block at top to tune)
  Compare.gs         match on Date+Area, score accuracy
  Index.html         two editable/scrollable panes + results
  Styles.html        CSS   ·   JavaScript.html  client glue
dashboard/
  sheet-schema.md        exact tabs/columns
  looker-setup-guide.md  step-by-step Looker build
  preview.html           self-contained dashboard mockup
samples/             example exports (rto / samsung)
test/run-tests.js    Node harness validating parser + comparison
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
of `Code.gs` to the target spreadsheet's ID. Finally connect Looker Studio to that
sheet per the setup guide.

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
  (`Mb`, `Ub`, `Ld`, `Ta`, …). Add/trim to match your plan labels.
- **`locator.sectionRe`** — how the Section is written (default matches `Sec-C`,
  `Sec C`, `Section C`).
- **`locator.segmentArea`** — optional map from each segment to its **Area 1–4**
  group (e.g. `{ 'Mb': 'Area 2', 'Ub': 'Area 4' }`) to power the dashboard's
  higher-level filter. Unmapped segments leave `area_group` blank.
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
