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

Messages are **free-form** (no fixed template needed). The parser reads each
message, canonicalises the **area/section** it mentions (so `zone b`, `Zone-B` and
`basement` all collapse to one section), and keys records on **Date + canonical
Area**. Messages with no recognisable area but real site content go to a
**`General`** bucket; greetings and acknowledgements are skipped. Each distinct key
resolves to:

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

## Tuning the parser to your real exports

`gas/Parser.gs` opens with a clearly-marked **`PARSER_CONFIG`** block — adjust it to
your exports, no logic changes needed:

- **`areas`** — the main thing to edit: your canonical sections and the free-text
  **aliases** that map to each (`{ name: 'Zone B', aliases: ['zone b','zone-b','basement'] }`).
  List more specific areas before broader ones; the first match wins.
- **`defaultArea`** — the bucket for records with no area match (default `General`).
- **`activityKeywords`** — words that mark a no-area message as real site content
  (so it reaches `General` instead of being dropped).
- **`chatterPatterns`** — greetings/acks to skip.
- **`labels`** — optional `Date:`/`Area:`/`Activity:`/`Remark:` synonyms; if a message
  is labelled, those win over the free-text heuristics (hybrid).
- **`lineFormats`** — the two WhatsApp export headers (iOS / Android), auto-detected.
- **`requireLabelledRecord`** — `false` (free-form). Set `true` only if your exports
  are strictly a labelled template.

Comparison leniency lives in `gas/Compare.gs` → `COMPARE_CONFIG.agreeThreshold`
(text-similarity bar; a quantity mismatch is always a Conflict regardless).

The sample files under `samples/` are free-form placeholders — replace them with real
lines and re-run `npm test`.
