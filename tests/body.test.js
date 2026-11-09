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
  ok("delta is this-week minus last-week, signed", tr.delta === -1, "got " + tr.delta);
}

/* --- 5. trend with no previous window ---------------------------- */
{
  setMeasurements([{ date: d(-20), weight: 76.0, waist: null }]);
  const tr = ctx.bodyTrend("weight", TODAY);
  ok("delta is null when the previous week is empty", tr.delta === null, "got " + tr.delta);
  ok("avg7 is null when this week is empty", tr.avg7 === null, "got " + tr.avg7);
  ok("latest still reports an out-of-window reading", tr.latest === 76.0, "got " + tr.latest);
}

/* --- 6. empty series --------------------------------------------- */
{
  setMeasurements([]);
  const tr = ctx.bodyTrend("weight", TODAY);
  ok("empty series returns nulls without throwing",
    tr.latest === null && tr.avg7 === null && tr.prev7 === null && tr.delta === null);
  ok("empty series yields an empty bodySeries", ctx.bodySeries("weight", 30, TODAY).length === 0);
}

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

  setMeasurements([]);
  ok("empty history renders no header", ctx.renderBodyHeader("weight", TODAY) === "");
}

/* --- 10. field toggle --------------------------------------------- */
{
  ctx.state.bodyField = "weight";
  ctx.setBodyField("waist");
  ok("setBodyField switches the active field", ctx.state.bodyField === "waist");
  ctx.setBodyField("weight");
}

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

/* --- summary ------------------------------------------------------ */
console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) { failures.forEach(f => console.log("  - " + f)); process.exit(1); }
