"use strict";
/* ============================================================
   Training Console - "NORMAL" difficulty regression tests
   Run:  node tests/difficulty-normal.test.js
   Exit code 0 = all green, 1 = failures.

   Guards the four-value difficulty scale added in v8.2:
   EASY | NORMAL | HARD | FAILED. "NORMAL" must be its own value
   end-to-end - a normal set must not be silently recorded as
   hard (no rest change, no suggestion change) or lumped into
   FAILED on the completion screen.
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

/* --- browser stub sandbox so the real inline script can boot ----- */
function loadApp() {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (scripts.length !== 1) throw new Error("expected exactly one inline script, found " + scripts.length);
  const src = scripts[0];

  const store = {};
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

  const localStorageStub = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; }
  };

  const documentStub = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) { return el(id); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() {
      return { style: {}, href: "", value: "", textContent: "", click() {}, setAttribute() {}, appendChild() {} };
    },
    execCommand() { return true; },
    body: { appendChild() {}, removeChild() {} }
  };

  const windowStub = { location: { reload() {} }, performance: { now: () => Date.now() }, addEventListener() {}, removeEventListener() {} };
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
    localStorage: localStorageStub,
    navigator: navigatorStub,
    window: windowStub,
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
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
  return { ctx: sandbox, html };
}

const { ctx, html } = loadApp();

/* One two-step queue so recordSetLog has a current step and can
   advance without entering the completion screen after step 1. */
function primeSession(step) {
  ctx.state.queue = [
    { name: "Test row", section: "MAIN", setIndex: 1, setTotal: 2, type: "reps",
      repsLabel: "8", restAfter: 60, day: "Monday" },
    { name: "Test row", section: "MAIN", setIndex: 2, setTotal: 2, type: "reps",
      repsLabel: "8", restAfter: 60, day: "Monday" }
  ];
  ctx.state.stepIdx = step || 0;
  ctx.state.phase = "logSet";
  ctx.state.view = "active";
  ctx.state.sessionLog = [];
  ctx.state.setLogs = [];
  ctx.state.restAdjustments = {};
  ctx.state.exerciseSuggestions = {};
  ctx.state.lastPR = null;
}

/* --- 1. the button exists on the post-exercise log panel ---------- */
const buttons = [...html.matchAll(/recordSetLog\(\\?['"]([a-z]+)\\?['"]\\?\)/g)].map(m => m[1]);
ok("log panel offers EASY", buttons.includes("easy"), "found: " + buttons.join(","));
ok("log panel offers NORMAL", buttons.includes("normal"), "found: " + buttons.join(","));
ok("log panel offers HARD", buttons.includes("hard"), "found: " + buttons.join(","));
ok("log panel offers FAILED", buttons.includes("failed"), "found: " + buttons.join(","));
ok("log panel offers exactly 4 difficulty buttons", buttons.length === 4, buttons.length + ": " + buttons.join(","));

const normalBtnMatch = html.match(/<button[^>]*onclick="recordSetLog\(\\?['"]normal\\?['"]\\?\)"[^>]*>([\s\S]*?)<\/button>/);
ok("NORMAL button renders a label", !!normalBtnMatch && /<span>NORMAL<\/span>/.test(normalBtnMatch[1]),
  normalBtnMatch ? normalBtnMatch[1].slice(0, 120) : "button not found");

/* --- 2. recordSetLog stores the raw value ------------------------- */
primeSession(0);
ctx.recordSetLog("normal");
const lastEntry = ctx.state.setLogs[ctx.state.setLogs.length - 1];
ok("recordSetLog('normal') persists difficulty='normal'",
  !!lastEntry && lastEntry.difficulty === "normal",
  lastEntry ? JSON.stringify(lastEntry.difficulty) : "no entry written");
ok("normal set is stored in the session log",
  ctx.state.sessionLog.length === 1 && ctx.state.sessionLog[0].difficulty === "normal",
  JSON.stringify(ctx.state.sessionLog.map(e => e.difficulty)));
ok("normal set survives the storage round-trip",
  JSON.parse(ctx.localStorage.getItem("set-log"))[0].difficulty === "normal",
  ctx.localStorage.getItem("set-log"));

/* --- 3. adaptive rest: normal leaves rest untouched --------------- */
ok("easy still cuts rest", ctx.calculateAdaptiveRest(60, "easy", "Row A") === 45,
  String(ctx.calculateAdaptiveRest(60, "easy", "Row A")));
ok("hard still adds rest", ctx.calculateAdaptiveRest(60, "hard", "Row B") === 75,
  String(ctx.calculateAdaptiveRest(60, "hard", "Row B")));
ok("failed still adds more rest", ctx.calculateAdaptiveRest(60, "failed", "Row C") === 90,
  String(ctx.calculateAdaptiveRest(60, "failed", "Row C")));
ok("normal keeps rest at base", ctx.calculateAdaptiveRest(60, "normal", "Row D") === 60,
  String(ctx.calculateAdaptiveRest(60, "normal", "Row D")));

/* --- 4. progression suggestion: normal holds the target ----------- */
primeSession(0);
ctx.computeSuggestion({ name: "Test row", type: "reps", repsLabel: "8" }, "easy", 8, null);
ok("easy bumps the suggested reps (+2)",
  ctx.state.exerciseSuggestions["Test row"].suggestedReps === 10,
  JSON.stringify(ctx.state.exerciseSuggestions["Test row"]));
ctx.computeSuggestion({ name: "Test row", type: "reps", repsLabel: "8" }, "normal", 8, null);
ok("normal holds the suggested reps",
  ctx.state.exerciseSuggestions["Test row"].suggestedReps === 10,
  JSON.stringify(ctx.state.exerciseSuggestions["Test row"]));
ctx.computeSuggestion({ name: "Test row", type: "reps", repsLabel: "8" }, "failed", 8, null);
ok("failed still drops the suggested reps (-2)",
  ctx.state.exerciseSuggestions["Test row"].suggestedReps === 8,
  JSON.stringify(ctx.state.exerciseSuggestions["Test row"]));
primeSession(0);
ctx.computeSuggestion({ name: "Test row", type: "time", duration: 30 }, "normal", null, 30);
ok("normal holds a timed suggestion",
  ctx.state.exerciseSuggestions["Test row"].suggestedDuration === 30,
  JSON.stringify(ctx.state.exerciseSuggestions["Test row"]));

/* --- 5. colour helper: every difficulty has its own colour -------- */
const hasColorHelper = typeof ctx.difficultyColor === "function";
ok("difficultyColor helper exists", hasColorHelper, "typeof difficultyColor = " + typeof ctx.difficultyColor);
const colours = hasColorHelper ? ["easy", "normal", "hard", "failed"].map(d => ctx.difficultyColor(d)) : [];
ok("difficultyColor returns 4 distinct colours",
  new Set(colours).size === 4, colours.join(","));
ok("difficultyColor has no undefined result", colours.every(c => typeof c === "string" && c.length > 0),
  colours.join(","));

/* --- 6. completion screen counts NORMAL on its own ---------------- */
ctx.state.sessionLog = [
  { exercise: "A", setIndex: 1, difficulty: "normal", actualReps: 8, section: "MAIN" },
  { exercise: "A", setIndex: 2, difficulty: "normal", actualReps: 8, section: "MAIN" },
  { exercise: "B", setIndex: 1, difficulty: "normal", actualReps: 8, section: "MAIN" },
  { exercise: "C", setIndex: 1, difficulty: "failed", actualReps: 4, section: "MAIN" }
];
ctx.state.view = "complete";
const completeHtml = ctx.renderComplete();
const normalCard = completeHtml.match(/<div class="statbox"><div class="statval"[^>]*>3<\/div><div class="statlabel dim">NORMAL<\/div>/);
ok("completion screen shows a NORMAL stat card with count 3", !!normalCard,
  "no statbox with value 3 labelled NORMAL");
const failedCard = completeHtml.match(/<div class="statbox"><div class="statval"[^>]*>1<\/div><div class="statlabel dim">FAILED<\/div>/);
ok("the 3 normal sets are not counted as FAILED (FAILED = 1)", !!failedCard,
  "expected a FAILED statbox with value 1");
const avgMatch = completeHtml.match(/class="statval"[^>]*>([^<]*)<\/div><div class="statlabel dim">AVG DIFFICULTY/);
ok("avg difficulty reflects a mostly-normal session",
  !!avgMatch && avgMatch[1] === "NORMAL",
  avgMatch ? "avgDiff=" + avgMatch[1] : "AVG DIFFICULTY statbox not found");

/* --- 7. difficulty colours surface in rendered views -------------- */
ctx.state.sessionLog = [{ exercise: "A", setIndex: 1, difficulty: "normal", actualReps: 8, section: "MAIN" }];
const breakHtml = ctx.renderComplete();
const normalColour = hasColorHelper ? ctx.difficultyColor("normal") : "unknown";
ok("completion set-breakdown colours NORMAL distinctly",
  breakHtml.includes(normalColour),
  "expected inline style to contain " + normalColour);

/* --- 8. heatmap scores normal between easy and hard --------------- */
const hasScoreHelper = typeof ctx.difficultyScore === "function";
ok("difficultyScore helper exists", hasScoreHelper, "typeof difficultyScore = " + typeof ctx.difficultyScore);
ok("difficultyScore ranks easy > normal > hard > failed",
  hasScoreHelper &&
  ctx.difficultyScore("easy") > ctx.difficultyScore("normal") &&
  ctx.difficultyScore("normal") > ctx.difficultyScore("hard") &&
  ctx.difficultyScore("hard") > ctx.difficultyScore("failed"),
  hasScoreHelper ? ["easy","normal","hard","failed"].map(d => d + "=" + ctx.difficultyScore(d)).join(" ") : "helper missing");
ok("difficultyScore treats unknown values as failed",
  hasScoreHelper && ctx.difficultyScore("nonsense") === ctx.difficultyScore("failed"),
  hasScoreHelper ? String(ctx.difficultyScore("nonsense")) : "helper missing");

/* --- 9. no view still hard-codes a 3-way easy/hard/failed colour -- */
const legacyColourTernaries = [...html.matchAll(/difficulty\s*===\s*"easy"\s*\?\s*"[^"]*"\s*:\s*[\w.]*difficulty\s*===\s*"hard"/g)].length;
ok("no remaining 3-way difficulty colour ternaries", legacyColourTernaries === 0,
  legacyColourTernaries + " raw ternary(s) still in source");

console.log("\n" + pass + " passed, " + failures.length + " failed");
process.exit(failures.length ? 1 : 0);
