# Training Console - Body Trend (v8.6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-field bar charts in the console's BODY tab with one line chart showing raw weight/waist plus the 7-day rolling average, and add a latest/average/week-on-week trend header.

**Architecture:** The data model is untouched - `state.measurements` already stores one row per date and already rides EXPORT/IMPORT. Three pure functions (`bodySeries`, `rollingAverage`, `bodyTrend`) do the maths, two renderers (`renderBodyChart`, `renderBodyHeader`) produce SVG/markup, and the existing BODY tab block is rewritten to call them. No new storage key, no migration, no navigation change.

**Tech Stack:** Single-file vanilla ES5 inline script in `index.html`, inline SVG, Node test harness that boots the real inline script in a `vm` sandbox.

**Spec:** `docs/superpowers/specs/2026-11-09-tc-body-trend-design.md`

## Global Constraints

- ES5 only inside `index.html`: `var`, `function`, no arrow functions, no template literals, no `const`/`let`.
- ASCII only in generated files.
- No new dependencies, no external chart library, no network calls.
- No new localStorage key. `state.measurements` stays the single source of truth.
- Commits: **do NOT run `git commit`, `git push` or open PRs.** The user has not authorised it. Every task ends at verification; report and wait.
- Existing suites must stay green: `tests\plan.test.js` 651, `progress` 17, `lockd-sync` 159, `calib-variant` 25, `difficulty-normal` 28, `overtime` 27, `ring-smooth` 13 = 920 assertions.
- Version bump `v8.5` -> `v8.6` must also update the pin at `tests\plan.test.js:1153`.

## File Structure

- `index.html` - modify only. Add pure functions after the measurement modal block (after line ~1798, before `EDIT MODAL`). Add `bodyField` to the `state` literal. Rewrite the BODY tab block (lines 3433-3483). Bump `APP_VERSION` (line 227).
- `tests/body.test.js` - create. New suite, same sandbox technique as `tests/progress.test.js`.
- `tests/plan.test.js` - modify one line (version pin).

---

### Task 1: Date helpers, series, rolling average, trend

**Files:**
- Create: `tests/body.test.js`
- Modify: `index.html:586` (state literal) and after `index.html:1798` (functions)

**Interfaces:**
- Consumes: `state.measurements` (`[{date:"YYYY-MM-DD", weight:Number|null, waist:Number|null, ...}]`, ascending), `localISO(Date)`.
- Produces:
  - `addDaysISO(iso, delta) -> "YYYY-MM-DD"`
  - `bodySeries(field, days, today) -> [{date, value}]` oldest-first, window `today-(days-1) .. today`
  - `rollingAverage(series, windowDays) -> [{date, value}]` same length as input
  - `bodyTrend(field, today) -> {latest, latestDate, avg7, prev7, delta}`

- [ ] **Step 1: Write the failing tests**

Create `tests/body.test.js`:

```js
"use strict";
/* ============================================================
   Training Console - body trend (v8.6)
   Run:  node tests/body.test.js
   Exit code 0 = all green, 1 = failures.

   Boots the REAL inline script in a browser stub sandbox (same
   technique as progress.test.js) and asserts behaviour, not source.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML_PATH = path.join(__dirname, "..", "index.html");

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("ok   - " + name); }
  else { failures.push(name + (detail ? "  ::  " + detail : "")); console.log("FAIL - " + name + (detail ? "  ::  " + detail : "")); }
}

function loadApp() {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (scripts.length !== 1) throw new Error("expected exactly one inline script, found " + scripts.length);
  const src = scripts[0];

  const elements = {};
  function el(id) {
    if (!elements[id]) {
      elements[id] = {
        id, innerHTML: "", value: "", textContent: "", href: "", className: "",
        style: {}, dataset: {},
        click() {}, focus() {}, blur() {}, remove() {},
        closest() { return null; }, querySelector() { return null; },
        addEventListener() {}, appendChild() {}
      };
    }
    return elements[id];
  }

  const documentStub = {
    visibilityState: "visible",
    addEventListener() {}, removeEventListener() {},
    getElementById(id) { return el(id); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() {
      return { style: {}, href: "", value: "", textContent: "", click() {}, setAttribute() {}, appendChild() {} };
    },
    execCommand() { return true; },
    body: { appendChild() {}, removeChild() {} }
  };

  const windowStub = {
    location: { reload() {} },
    performance: { now: () => Date.now() },
    open() { return { closed: false }; },
    addEventListener() {}, removeEventListener() {}
  };
  const navigatorStub = {
    vibrate() {},
    wakeLock: { request: () => Promise.resolve({}) },
    clipboard: { writeText: () => Promise.resolve() },
    serviceWorker: {
      register: () => Promise.resolve({}),
      getRegistration: () => Promise.resolve(null),
      addEventListener() {}
    }
  };

  const sandbox = {
    document: documentStub,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: navigatorStub,
    window: windowStub,
    console,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    alert() {},
    confirm: () => false,
    performance: { now: () => Date.now() }
  };
  windowStub.AudioContext = undefined;
  windowStub.webkitAudioContext = undefined;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "index-inline.js" });
  return sandbox;
}

const ctx = loadApp();

/* Fixed clock: 2026-11-09, so offsets are deterministic. */
const BASE = new Date(2026, 10, 9);
function d(offset) {
  const x = new Date(BASE.getTime());
  x.setDate(x.getDate() + offset);
  return ctx.localISO(x);
}
const TODAY = d(0);
function setMeasurements(rows) { ctx.state.measurements = rows; }

/* --- 1. rolling average on dense daily data ---------------------- */
{
  const weights = [76.0, 76.2, 76.1, 76.4, 76.3, 76.5, 76.2];
  setMeasurements(weights.map((w, i) => ({ date: d(i - 6), weight: w, waist: null })));
  const series = ctx.bodySeries("weight", 30, TODAY);
  const avg = ctx.rollingAverage(series, 7);

  ok("bodySeries returns every in-window reading", series.length === 7, "got " + series.length);
  ok("first point averages only itself", avg[0].value === 76.0, "got " + avg[0].value);
  ok("last point averages the full 7 days", avg[6].value === 76.24, "got " + avg[6].value);
  ok("rolling average keeps the input length", avg.length === series.length);
}

/* --- 2. gaps never produce NaN ----------------------------------- */
{
  setMeasurements([
    { date: d(-10), weight: 77.0, waist: null },
    { date: d(-3), weight: 76.4, waist: null },
    { date: d(0), weight: 76.0, waist: null }
  ]);
  const series = ctx.bodySeries("weight", 30, TODAY);
  const avg = ctx.rollingAverage(series, 7);
  ok("every averaged value is finite with gaps present", avg.every(p => isFinite(p.value)), JSON.stringify(avg));
  ok("a one-reading window returns that reading", avg[1].value === 76.4, "got " + avg[1].value);
}

/* --- 3. window edges --------------------------------------------- */
{
  setMeasurements([
    { date: d(-40), weight: 80.0, waist: null },
    { date: d(-1), weight: 76.0, waist: null },
    { date: d(0), weight: 76.2, waist: null }
  ]);
  const series = ctx.bodySeries("weight", 30, TODAY);
  ok("readings older than the window are excluded", series.length === 2, "got " + series.length);
  ok("the oldest in-window reading is d(-1)", series[0].date === d(-1), series[0].date);
}

/* --- 4. trend delta ---------------------------------------------- */
{
  const rows = [];
  for (let i = 13; i >= 7; i--) rows.push({ date: d(-i), weight: 77.0, waist: null });
  for (let i = 6; i >= 0; i--) rows.push({ date: d(-i), weight: 76.0, waist: null });
  setMeasurements(rows);
  const tr = ctx.bodyTrend("weight", TODAY);
  ok("latest reading is today's", tr.latest === 76.0 && tr.latestDate === TODAY, JSON.stringify(tr));
  ok("avg7 is this week's mean", tr.avg7 === 76.0, "got " + tr.avg7);
  ok("prev7 is last week's mean", tr.prev7 === 77.0, "got " + tr.prev7);
  ok("delta is prev-week minus this-week, signed", tr.delta === -1, "got " + tr.delta);
}

/* --- 5. trend with no previous window ---------------------------- */
{
  setMeasurements([{ date: d(-2), weight: 76.0, waist: null }]);
  const tr = ctx.bodyTrend("weight", TODAY);
  ok("delta is null when the previous week is empty", tr.delta === null, "got " + tr.delta);
  ok("avg7 is null when this week is empty", tr.avg7 === null, "got " + tr.avg7);
}

/* --- 6. empty series --------------------------------------------- */
{
  setMeasurements([]);
  const tr = ctx.bodyTrend("weight", TODAY);
  ok("empty series returns nulls without throwing",
    tr.latest === null && tr.avg7 === null && tr.prev7 === null && tr.delta === null);
  ok("empty series yields an empty bodySeries", ctx.bodySeries("weight", 30, TODAY).length === 0);
}

/* --- summary ------------------------------------------------------ */
console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) { failures.forEach(f => console.log("  - " + f)); process.exit(1); }
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests\body.test.js` inside `C:\Users\adamd\training-console`
Expected: FAIL - `ctx.addDaysISO is not a function` (or `bodySeries is not a function`).

- [ ] **Step 3: Add `bodyField` to the state literal**

In `index.html`, inside `var state = {`, immediately after the `measurementModal: null,` / `measurements: [],` pair, add:

```js
  bodyField: "weight",
```

- [ ] **Step 4: Add the pure functions**

Insert after the closing brace of `renderMeasurementModal()` (just before the `EDIT MODAL` comment block):

```js
/* ============================================================
   BODY TREND (v8.6) - series, 7-day rolling average, week delta
   Pure functions: no DOM, no storage, safe to test directly.
   ============================================================ */
function addDaysISO(iso, delta) {
  var p = iso.split("-");
  var dt = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
  dt.setDate(dt.getDate() + delta);
  return localISO(dt);
}

function bodySeries(field, days, today) {
  var from = addDaysISO(today, -(days - 1));
  var out = [];
  for (var i = 0; i < state.measurements.length; i++) {
    var m = state.measurements[i];
    if (m[field] == null) continue;
    if (m.date < from || m.date > today) continue;
    out.push({ date: m.date, value: m[field] });
  }
  return out;
}

function rollingAverage(series, windowDays) {
  var w = windowDays || 7;
  var out = [];
  for (var i = 0; i < series.length; i++) {
    var from = addDaysISO(series[i].date, -(w - 1));
    var sum = 0, n = 0;
    for (var j = 0; j <= i; j++) {
      if (series[j].date < from || series[j].date > series[i].date) continue;
      sum += series[j].value;
      n++;
    }
    out.push({ date: series[i].date, value: Math.round((sum / n) * 100) / 100 });
  }
  return out;
}

function meanInWindow(field, today, fromOffset, toOffset) {
  var from = addDaysISO(today, fromOffset);
  var to = addDaysISO(today, toOffset);
  var sum = 0, n = 0;
  for (var i = 0; i < state.measurements.length; i++) {
    var m = state.measurements[i];
    if (m[field] == null) continue;
    if (m.date < from || m.date > to) continue;
    sum += m[field];
    n++;
  }
  return n ? Math.round((sum / n) * 100) / 100 : null;
}

function bodyTrend(field, today) {
  var series = bodySeries(field, 3650, today);
  var latest = series.length ? series[series.length - 1] : null;
  var avg7 = meanInWindow(field, today, -6, 0);
  var prev7 = meanInWindow(field, today, -13, -7);
  return {
    latest: latest ? latest.value : null,
    latestDate: latest ? latest.date : null,
    avg7: avg7,
    prev7: prev7,
    delta: (avg7 != null && prev7 != null) ? Math.round((avg7 - prev7) * 100) / 100 : null
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node tests\body.test.js`
Expected: `12 passed, 0 failed`, exit 0.

- [ ] **Step 6: Run the existing suites**

Run: `node tests\plan.test.js; node tests\progress.test.js`
Expected: 651/0 and 17/0, both exit 0.

---

### Task 2: Chart and header renderers

**Files:**
- Modify: `index.html` (append below the Task 1 functions)
- Modify: `tests/body.test.js` (append new assertions before the summary block)

**Interfaces:**
- Consumes: `bodySeries`, `rollingAverage`, `bodyTrend`, `theme()`, `TEXT_DIM`.
- Produces:
  - `bodyDeltaColor(field, delta) -> CSS colour string`
  - `renderBodyHeader(field, today) -> html string` (empty string when no readings)
  - `renderBodyChart(field, today) -> html string`
  - `setBodyField(field) -> void`

- [ ] **Step 1: Write the failing tests**

In `tests/body.test.js`, insert **before** the `/* --- summary --- */` block:

```js
/* --- 7. chart markup --------------------------------------------- */
{
  setMeasurements([
    { date: d(-3), weight: 76.4, waist: null },
    { date: d(-2), weight: 76.2, waist: null },
    { date: d(-1), weight: 76.3, waist: null },
    { date: d(0), weight: 76.0, waist: null }
  ]);
  const svg = ctx.renderBodyChart("weight", TODAY);
  ok("chart renders an svg", /<svg/.test(svg));
  ok("chart draws two polylines (raw + average)", (svg.match(/<polyline/g) || []).length === 2,
    String((svg.match(/<polyline/g) || []).length));
  ok("chart draws one dot per reading", (svg.match(/<circle/g) || []).length === 4,
    String((svg.match(/<circle/g) || []).length));
}

/* --- 8. chart empty state ---------------------------------------- */
{
  setMeasurements([{ date: d(0), weight: 76.0, waist: null }]);
  const svg = ctx.renderBodyChart("weight", TODAY);
  ok("one reading renders the empty state", !/<svg/.test(svg) && /at least two readings/.test(svg));
}

/* --- 9. header ---------------------------------------------------- */
{
  const rows = [];
  for (let i = 13; i >= 7; i--) rows.push({ date: d(-i), weight: 77.0, waist: 84.0 });
  for (let i = 6; i >= 0; i--) rows.push({ date: d(-i), weight: 76.0, waist: 83.0 });
  setMeasurements(rows);
  const head = ctx.renderBodyHeader("weight", TODAY);
  ok("header shows the latest value", /76 kg/.test(head), head.slice(0, 120));
  ok("header shows the 7-day average", /7-DAY AVG/.test(head));
  ok("header shows a signed delta", /-1\.0/.test(head), head.slice(0, 200));
  ok("empty history renders no header", ctx.renderBodyHeader("weight", d(400)) === "");
}

/* --- 10. field toggle --------------------------------------------- */
{
  ctx.state.bodyField = "weight";
  ctx.setBodyField("waist");
  ok("setBodyField switches the active field", ctx.state.bodyField === "waist");
  ctx.setBodyField("weight");
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `node tests\body.test.js`
Expected: FAIL - `ctx.renderBodyChart is not a function`.

- [ ] **Step 3: Implement the renderers**

Append after `bodyTrend` in `index.html`:

```js
function bodyDeltaColor(field, delta) {
  var t = theme();
  if (delta == null) return TEXT_DIM;
  if (field === "weight") {
    return (delta >= -0.3 && delta <= 0.3) ? t.accent : "#ffb547";
  }
  if (delta <= -0.5) return "#39ff88";
  if (delta >= 0.5) return "#ffb547";
  return t.accent;
}

function setBodyField(field) {
  state.bodyField = field === "waist" ? "waist" : "weight";
  render();
}

function renderBodyHeader(field, today) {
  var t = theme();
  var tr = bodyTrend(field, today);
  if (tr.latest == null) return "";
  var unit = field === "weight" ? "kg" : "cm";
  var deltaTxt = tr.delta == null ? "--" : (tr.delta > 0 ? "+" : "") + tr.delta.toFixed(1);
  function box(val, label, color) {
    return '<div class="statbox"><div class="statval" style="font-size:16px;color:' + color + ';">' + val +
      '</div><div class="statlabel dim">' + label + '</div></div>';
  }
  return '<div class="panel" style="margin-bottom:12px;">' +
    '<div class="dim" style="font-size:10px;letter-spacing:2px;margin-bottom:10px;">' + field.toUpperCase() + ' TREND</div>' +
    '<div class="statgrid" style="grid-template-columns:1fr 1fr 1fr;">' +
      box(tr.latest + " " + unit, "LATEST", t.accent) +
      box(tr.avg7 == null ? "--" : tr.avg7.toFixed(1) + " " + unit, "7-DAY AVG", t.accent) +
      box(deltaTxt, "VS LAST WEEK", bodyDeltaColor(field, tr.delta)) +
    '</div></div>';
}

function renderBodyChart(field, today) {
  var t = theme();
  var series = bodySeries(field, 90, today);
  if (series.length < 2) {
    return '<div class="panel" style="text-align:center;color:' + TEXT_DIM +
      ';font-size:12px;padding:26px;">Log at least two readings to see a trend</div>';
  }

  var full = bodySeries(field, 3650, today);
  var avg = rollingAverage(full, 7);
  var avgMap = {};
  for (var a = 0; a < avg.length; a++) avgMap[avg[a].date] = avg[a].value;

  var vals = series.map(function (p) { return p.value; });
  var min = Math.min.apply(null, vals);
  var max = Math.max.apply(null, vals);
  var pad = (max - min) * 0.05;
  min -= pad; max += pad;
  var range = (max - min) || 1;

  var W = 340, H = 150, L = 10, R = 330, TOP = 12, BOT = 130;
  function xAt(i) { return L + (R - L) * (i / (series.length - 1)); }
  function yAt(v) { return BOT - (BOT - TOP) * ((v - min) / range); }

  var rawPts = [], avgPts = [], dots = [];
  for (var i = 0; i < series.length; i++) {
    var px = xAt(i).toFixed(1), py = yAt(series[i].value).toFixed(1);
    rawPts.push(px + "," + py);
    dots.push('<circle cx="' + px + '" cy="' + py + '" r="2" fill="' + t.accentDim + '"/>');
    var av = avgMap[series[i].date];
    if (av != null) avgPts.push(px + "," + yAt(av).toFixed(1));
  }

  var mid = Math.floor((series.length - 1) / 2);
  var marks = [series[0], series[mid], series[series.length - 1]];
  var labels = "";
  for (var k = 0; k < marks.length; k++) {
    var lx = k === 0 ? L : (k === 1 ? (L + R) / 2 : R);
    var anchor = k === 0 ? "start" : (k === 1 ? "middle" : "end");
    labels += '<text x="' + lx.toFixed(1) + '" y="146" fill="' + TEXT_DIM +
      '" font-size="8" text-anchor="' + anchor + '">' + marks[k].date.slice(5) + '</text>';
  }

  return '<div class="panel" style="margin-bottom:12px;">' +
    '<div class="dim" style="font-size:9px;letter-spacing:1px;margin-bottom:8px;">' +
      field.toUpperCase() + ' - LAST 90 DAYS (raw + 7-day average)</div>' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">' +
      '<polyline points="' + rawPts.join(" ") + '" fill="none" stroke="' + TEXT_DIM + '" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<polyline points="' + avgPts.join(" ") + '" fill="none" stroke="' + t.accent + '" stroke-width="2.5" stroke-linejoin="round"/>' +
      dots.join("") + labels +
    '</svg></div>';
}
```

- [ ] **Step 4: Run the tests**

Run: `node tests\body.test.js`
Expected: `22 passed, 0 failed`, exit 0.

---

### Task 3: Wire the BODY tab, bump the version, full regression

**Files:**
- Modify: `index.html:3433-3483` (BODY tab block)
- Modify: `index.html:227` (`APP_VERSION`)
- Modify: `tests/plan.test.js:1153` (version pin)
- Modify: `tests/body.test.js` (integration assertions)

**Interfaces:**
- Consumes: `renderBodyHeader`, `renderBodyChart`, `setBodyField`, `state.bodyField`, `localISO`.
- Produces: the rendered BODY tab.

- [ ] **Step 1: Write the failing integration tests**

Insert before the summary block in `tests/body.test.js`:

```js
/* --- 11. the BODY tab renders the new pieces ---------------------- */
{
  const rows = [];
  for (let i = 6; i >= 0; i--) rows.push({ date: d(-i), weight: 76.0 + (i * 0.1), waist: 83.0 });
  setMeasurements(rows);
  ctx.state.statsTab = "measurements";
  ctx.state.bodyField = "weight";
  const html = ctx.renderStats();
  ok("BODY tab renders the trend header", /WEIGHT TREND/.test(html));
  ok("BODY tab renders the chart", /<svg/.test(html));
  ok("BODY tab offers the WEIGHT/WAIST toggle", /WAIST/.test(html) && /WEIGHT/.test(html));
}

/* --- 12. legacy rows without waist -------------------------------- */
{
  setMeasurements([
    { date: d(-1), weight: 76.0 },
    { date: d(0), weight: 76.1 }
  ]);
  const svg = ctx.renderBodyChart("waist", TODAY);
  ok("rows missing waist fall back to the empty state", /at least two readings/.test(svg));
}

/* --- 13. re-entry replaces, never duplicates ---------------------- */
{
  ctx.state.measurements = [];
  ctx.state.measurementModal = { weight: 76, chest: "", waist: "", hips: "", arms: "", thighs: "" };
  ctx.document.getElementById("meas_weight").value = "76.0";
  ctx.saveMeasurementModal();
  ctx.state.measurementModal = { weight: 76, chest: "", waist: "", hips: "", arms: "", thighs: "" };
  ctx.document.getElementById("meas_weight").value = "75.5";
  ctx.saveMeasurementModal();
  ok("one row per date survives a re-entry",
    ctx.state.measurements.length === 1 && ctx.state.measurements[0].weight === 75.5,
    JSON.stringify(ctx.state.measurements));
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `node tests\body.test.js`
Expected: FAIL - `BODY tab renders the trend header` (the old bar-chart block has no header).

- [ ] **Step 3: Replace the BODY tab block**

Replace the entire `/* TAB: Body Measurements */` block (currently `if (state.statsTab === "measurements") { ... }`, lines 3433-3483) with:

```js
  /* TAB: Body Measurements */
  if (state.statsTab === "measurements") {
    var mFields = ["weight","chest","waist","hips","arms","thighs"];
    var mLabels = { weight:"WEIGHT (kg)", chest:"CHEST (cm)", waist:"WAIST (cm)", hips:"HIPS (cm)", arms:"ARMS (cm)", thighs:"THIGHS (cm)" };
    var bodyField = state.bodyField === "waist" ? "waist" : "weight";
    var bodyToday = localISO(new Date());

    html += '<div class="panel" style="margin-bottom:16px;text-align:center;">'+
      '<button onclick="openMeasurementModal()" style="padding:12px 20px;border-radius:10px;background:'+t.accent+';color:#02080a;font-size:12px;letter-spacing:1px;font-weight:bold;">LOG MEASUREMENTS</button>'+
      '</div>';

    if (state.measurements.length === 0) {
      html += '<div class="panel" style="text-align:center;color:'+TEXT_DIM+';font-size:13px;padding:30px;">No measurements logged yet. Tap the button above to start tracking.</div>';
    } else {
      html += '<div class="panel" style="margin-bottom:12px;padding:6px;display:flex;gap:4px;">';
      ["weight","waist"].forEach(function(f){
        var active = bodyField === f;
        html += '<button onclick="setBodyField(\''+f+'\')" style="flex:1;padding:8px 4px;border-radius:8px;font-size:10px;letter-spacing:1px;background:'+(active?t.accent:'transparent')+';color:'+(active?'#02080a':TEXT_DIM)+';border:none;cursor:pointer;">'+f.toUpperCase()+'</button>';
      });
      html += '</div>';

      html += renderBodyHeader(bodyField, bodyToday);
      html += renderBodyChart(bodyField, bodyToday);

      var latest = state.measurements[state.measurements.length - 1];
      html += '<div class="panel" style="margin-bottom:16px;"><div class="dim" style="font-size:10px;letter-spacing:2px;margin-bottom:10px;">LATEST - '+latest.date+'</div>';
      html += '<div class="statgrid" style="grid-template-columns:1fr 1fr 1fr;">';
      mFields.forEach(function(f){
        if (latest[f] != null) {
          html += '<div class="statbox"><div class="statval" style="font-size:16px;color:'+t.accent+';">'+latest[f]+'</div><div class="statlabel dim">'+mLabels[f]+'</div></div>';
        }
      });
      html += '</div></div>';

      html += '<div class="panel" style="margin-bottom:16px;"><div class="dim" style="font-size:10px;letter-spacing:2px;margin-bottom:8px;">HISTORY</div>';
      state.measurements.slice().reverse().forEach(function(m){
        var summary = mFields.filter(function(f){ return m[f] != null; }).map(function(f){ return m[f] + " " + f.charAt(0).toUpperCase() + f.slice(1); }).join(" - ");
        html += '<div class="exline"><span style="color:'+t.accent+';">'+m.date+'</span><span class="dim" style="white-space:nowrap;font-size:10px;">'+summary+'</span></div>';
      });
      html += '</div>';
    }
  }
```

- [ ] **Step 4: Bump the version**

`index.html` line 227: change `var APP_VERSION = "v8.5";` to `var APP_VERSION = "v8.6";`

`tests/plan.test.js` line 1153: change the pin to `ok("APP_VERSION bumped to v8.6", /var APP_VERSION = "v8\.6"/.test(src));`

- [ ] **Step 5: Run everything**

Run each, expecting exit 0:

```
node tests\body.test.js
node tests\plan.test.js
node tests\progress.test.js
node tests\lockd-sync.test.js
node tests\calib-variant.test.js
node tests\difficulty-normal.test.js
node tests\overtime.test.js
node tests\ring-smooth.test.js
```

Expected: body 25/0, plan 651/0, progress 17/0, lockd-sync 159/0, calib-variant 25/0, difficulty-normal 28/0, overtime 27/0, ring-smooth 13/0.

- [ ] **Step 6: Real-browser smoke test**

Open the working copy directly (`Start-Process index.html` is acceptable here - local file, not a URL) and check:
- Stats -> BODY renders the toggle, trend header, chart and history.
- Logging a measurement updates the header and chart immediately.
- The WAIST toggle switches the chart and header.
- No console errors.

Report the result. **Do not commit.**

---

## Self-Review

- Spec coverage: data model (untouched), three pure functions (Task 1), chart + toggle + 90-day window + gap handling + index spacing (Task 2), header + colour rules (Task 2), BODY tab integration (Task 3), legacy import tolerance (Task 3 test 12), version and regression (Task 3).
- Placeholder scan: none - every step carries real code or an exact command.
- Type consistency: `bodySeries(field, days, today)`, `rollingAverage(series, windowDays)`, `bodyTrend(field, today)`, `renderBodyHeader(field, today)`, `renderBodyChart(field, today)`, `setBodyField(field)` are used identically in tests and implementation. `meanInWindow(field, today, fromOffset, toOffset)` is internal only.
- Gaps found and fixed inline: version pin in `plan.test.js` (would have reddened the suite), and `todayISO` vs `localISO(new Date())` - the tab uses a fresh date so the screen is correct past midnight.
