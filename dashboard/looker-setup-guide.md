# Looker Studio setup — Director & team dashboard

Goal: a view-only report the director and team open to see daily accuracy,
site-activity highlights, and drill down by **date** and **section/area** — fed by
the Google Sheet the GAS app writes (see `sheet-schema.md`).

`preview.html` in this folder is a working mockup of the target layout — open it
to see the intended scorecards, charts, and table before you build.

---

## 1. Connect the data source

1. Open <https://lookerstudio.google.com> → **Create → Report**.
2. **Add data → Google Sheets** connector → pick the N106 spreadsheet.
3. Add each tab as its own data source: **`Comparison`**, **`DailySummary`**,
   and (optional) **`Records`**.
4. For each, confirm field types match `sheet-schema.md` — especially set
   `date` to **Date (YYYYMMDD)** and the count columns to **Number**.
5. On the `Comparison` source, add the calculated fields listed at the bottom of
   `sheet-schema.md` (Is Matched / Is Conflict / Is Missing / Status label).

## 2. Add the controls (top row)

Place these across the top so every chart responds to them:

- **Date range control** — set to the `date` field. Default: last 7 days.
- **Drop-down control** — dimension `date` (or a dedicated "Day" list).
- **Drop-down control** — dimension `area` (the section/area filter).

All charts on the page inherit page-level filters, so these drive everything.

## 3. Scorecards (KPI row)

Use the **`DailySummary`** source (already aggregated):

| Scorecard | Metric | Notes |
|-----------|--------|-------|
| Accuracy | `accuracy_pct` (AVG, or `SUM(matched)/SUM(total_keys)`) | show as % |
| Matched | `matched` (SUM) | green |
| Conflicts | `conflicts` (SUM) | amber |
| Missing | `missing` (SUM) | red |
| Total keys | `total_keys` (SUM) | |

Set each scorecard's comparison to **previous period** for the up/down delta.

## 4. Charts

1. **Daily accuracy — time series (line).**
   Source `DailySummary`; dimension `date`; metric `accuracy_pct`.
   Y-axis 0–100. This is the headline trend.

2. **Status breakdown by day — stacked column.**
   Source `Comparison`; dimension `date`; breakdown dimension `status` (or the
   Status label field); metric `Record Count`. Colour by status:
   Match = green `#0ca30c`, Conflict = amber `#fab219`, Missing* = red `#d03b3b`.

3. **Accuracy by area — bar (optional).**
   Source `Comparison`; dimension `area`; metric `Accuracy %`. Sorted ascending
   surfaces the worst-reporting areas first.

## 5. Detail table (the drill-down)

Source `Comparison`; a **table** with columns:
`date, area, Status label, similarity, rto_activity, samsung_activity,
rto_remark, samsung_remark`.

- Enable the table's own filter + sort.
- Add **conditional formatting** on `status`: green background for Match, amber
  for Conflict, red for Missing*. This is the "highlighted site activities" view.

## 6. Colour, theme & sharing

- **Theme → Customise**: set the status colours above as the report palette so
  every chart is consistent.
- **Share**: give the director and team **Viewer** access (link or by email).
  Viewers cannot edit — they filter and read only, exactly the intended split.
- Set the report to **refresh** (Sheets data caches ~15 min; use *Refresh data*
  after each new upload, or lower the cache in data-source settings).

## Daily flow

1. You paste/upload both exports in the GAS web app and click **Compare**.
2. Review the result, click **Save to Sheet**.
3. The director's Looker report shows the new day after a data refresh — they
   filter by date/area and read the highlights. No editing on their side.
