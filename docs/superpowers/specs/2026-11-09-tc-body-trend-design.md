# Training Console - Body Trend (v8.6) Design

Date: 2026-11-09
Status: approved (design), spec awaiting review
Repo: `C:\Users\adamd\training-console`
Supersedes: nothing. Extends the existing BODY tab.

## 1. Context

The console already ships a BODY tab (stats -> BODY) with a measurement modal and
one row per date stored in `state.measurements` (localStorage key
`body-measurements`). Fields: weight, chest, waist, hips, arms, thighs. The row is
replaced when the same date is re-entered, the array is kept sorted, and the data
is already included in EXPORT / IMPORT.

What the tab cannot do is show a trend: each field is rendered as an independent
bar chart, with no rolling average, no delta and no shared axis.

The nutrition plan depends on exactly one number - the 7-day weight average - and
one secondary one, the waist trend. That is the gap this work closes.

## 2. Goals

- Show weight and waist as a line chart with the 7-day rolling average drawn over it.
- Show latest reading, 7-day average and week-on-week delta at a glance.
- Keep the existing data model and backup format byte-for-byte compatible.
- Test the maths independently of the UI.

## 3. Non-goals

- No new storage key, no migration, no schema change.
- No new top-level screen or navigation change.
- No past-date editing (the modal continues to write today only).
- No photo storage, no goal-weight line, no TDEE/macro calculation in the app.
- No sync changes. Body data stays local and rides the existing backup.

## 4. Data model

Unchanged.

```
state.measurements = [
  { date: "2026-11-10", weight: 76.0, waist: 82.5, chest: null, hips: null,
    arms: null, thighs: null }
]
```

Invariants already enforced by `saveMeasurementModal()`: one row per `date`,
ascending sort by `date`, `null` for fields left blank, invalid values rejected.

Dates are local `YYYY-MM-DD` produced by the existing `todayISO` / `localISO`
helpers. No UTC conversion anywhere.

## 5. New pure functions

All three operate on plain arrays and return plain objects, so they can be tested
without touching the DOM. Dates are compared as strings (ISO sorts lexicographically).

### `bodySeries(field, days, today)`
Returns `[{ date, value }]` oldest-first for rows where `field != null` and
`date >= today - (days - 1)`.

### `rollingAverage(series, windowDays = 7)`
For every point `p` in `series`, the output value is the mean of all series points
with `date >= p.date - (windowDays - 1)` and `date <= p.date`. Returns the same
number of points as the input, rounded to 2 decimals. A window with one reading
returns that reading. Duplicate dates cannot occur (one row per date).

This runs on the **full** history, not the display window, and the chart slices to
the last 90 days afterwards. Otherwise the leftmost points would average a partial
window and dip for no real reason.

### `bodyTrend(field, today)`
- `latest` / `latestDate` - the most recent non-null reading, or null.
- `avg7` - mean of readings with `date >= today - 6` and `date <= today`, or null.
- `prev7` - mean of readings with `date >= today - 13` and `date <= today - 7`, or null.
- `delta` - `avg7 - prev7`, or null when either side is null.

`avg7` is defined by calendar window, not by "last seven readings", so a two-week
gap cannot silently compare a fresh week against an old one.

## 6. Chart

Inline SVG, no library, `viewBox="0 0 340 150"`, width 100%.

- Window: last 90 days. Fewer points than the window is fine.
- Raw series: dim polyline, 1.5 px, with 2 px dots at each point.
- 7-day average: accent polyline, 2.5 px, no dots, drawn above the raw line.
- Y scale: raw min/max with 5 percent padding; `range = 0` guarded to 1.
- X labels: first, middle and last date as `MM-DD`, dim, 8 px.
- Points are spaced evenly by index, not proportionally by date, so gaps compress
  rather than stretching the line.
- Empty state: fewer than two raw points renders
  "Log at least two readings to see a trend" instead of an SVG.

Field toggle sits above the chart: `WEIGHT | WAIST`. Active field is held in
memory as `state.bodyField` (default `"weight"`); not persisted.

## 7. Header

Three stat boxes above the chart, reusing the existing `statbox` markup:

| Box | Weight | Waist |
|---|---|---|
| LATEST | value + date | value + date |
| 7-DAY AVG | 1 decimal | 1 decimal |
| TREND | signed delta vs previous week | signed delta vs previous week |

Colour rules, deliberately conservative and exhaustive (no unhandled band):

- Weight: `-0.3 <= delta <= +0.3` accent (on target); `delta > +0.3` amber (watch);
  `delta < -0.3` amber (may be under-fed).
- Waist: `delta <= -0.5` green (progress); `delta >= +0.5` amber; otherwise accent.
- `delta == null`: dash, no colour.

## 8. Files touched

- `index.html` - three functions, chart renderer, header renderer, one toggle
  handler, and the BODY tab block rewritten to use them.
- `tests/body.test.js` - new suite.
- `APP_VERSION` -> `v8.6`.

No other files change.

## 9. Error handling

- Empty or single-point series: empty state, no exceptions, no NaN in the DOM.
- `null` / missing fields: skipped by `bodySeries`, never averaged.
- Corrupt stored JSON: existing `loadState` behaviour is unchanged (wrapped in
  try/catch at line 640); this work does not alter it.
- Old backups without any measurement fields: import path already guards with
  `Array.isArray`.

## 10. Testing

New suite `tests/body.test.js` boots the real inline script in the same sandbox
style as `tests/progress.test.js`. Assertions:

1. `rollingAverage` on seven dense daily points returns the expected means.
2. `rollingAverage` with gaps never returns NaN and ignores missing days.
3. `rollingAverage` at the window edges (first points) averages only what exists.
4. `bodySeries(field, days, today)` excludes rows older than the window.
5. `bodyTrend` delta is correct for two full windows.
6. `bodyTrend` returns `delta: null` when the previous window is empty.
7. `bodyTrend` returns nulls for an empty series without throwing.
8. Chart renders one SVG polyline per series and the right dot count.
9. Fewer than two points renders the empty-state text, not an SVG.
10. Toggle switches the rendered field.
11. Re-entering the same date replaces the row, never duplicates.
12. A legacy `state.measurements` payload imports unchanged.

Acceptance: `node tests\body.test.js` exit 0, and all seven existing suites remain
green at 920 assertions.

## 11. Out of scope but noted

Row-tap editing of past dates is the obvious next ask if a typo ever needs
correcting. Deliberately omitted under YAGNI; one small change if requested.
