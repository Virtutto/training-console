"use strict";
/* ============================================================
   Training Console - session progress percentage (v8.4)
   Run:  node tests/progress.test.js
   Exit code 0 = all green, 1 = failures.

   The old readout was stepIdx / queue.length:
     - 0% for the whole first set (no credit for work in progress)
     - never 100% (the final set of a 20-step day read 95%)
     - only moved when a set was logged
   v8.4 measures completed steps plus the fraction of the current
   step: a timed hold counts its elapsed seconds, a set counts the
   moment it is logged, and a rep set counts only after FINISH SET.

   Boots the REAL inline script in a browser stub sandbox (same
   technique as calib-variant.test.js) and asserts behaviour, not
   source text.
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

/* --- fixtures ----------------------------------------------------- */
function holdStep(over) {
  return Object.assign({
    section: "MAIN", name: "Test hold", setIndex: 1, setTotal: 1,
    type: "time", duration: 20, repsLabel: null, cue: "", restAfter: 60
  }, over || {});
}
function repStep(over) {
  return Object.assign({
    section: "MAIN", name: "Test reps", setIndex: 1, setTotal: 1,
    type: "reps", duration: undefined, repsLabel: "5 reps", cue: "", restAfter: 60
  }, over || {});
}
function fourHolds() { return [holdStep(), holdStep(), holdStep(), holdStep()]; }

/* Put the app into a precise moment of a session and read the number. */
function percentAt(o) {
  ctx.state.queue = o.queue;
  ctx.state.stepIdx = o.stepIdx;
  ctx.state.phase = o.phase;
  ctx.state.secondsLeft = o.secondsLeft == null ? 0 : o.secondsLeft;
  ctx.state.paused = !!o.paused;
  return ctx.sessionProgressPercent();
}

/* --- 1. the shape of the number ---------------------------------- */
{
  ok("empty queue reads 0", percentAt({ queue: [], stepIdx: 0, phase: "windup" }) === 0);

  const q = fourHolds();
  const vals = [
    percentAt({ queue: q, stepIdx: 0, phase: "windup", secondsLeft: 5 }),
    percentAt({ queue: q, stepIdx: 1, phase: "work", secondsLeft: 20 }),
    percentAt({ queue: q, stepIdx: 1, phase: "work", secondsLeft: 10 }),
    percentAt({ queue: q, stepIdx: 1, phase: "logSet" }),
    percentAt({ queue: q, stepIdx: 3, phase: "logSet" })
  ];
  ok("every value is an integer inside 0..100",
    vals.every(v => Number.isInteger(v) && v >= 0 && v <= 100), JSON.stringify(vals));
}

/* --- 2. the first set is not 0% anymore --------------------------- */
{
  const q = fourHolds();
  const start = percentAt({ queue: q, stepIdx: 0, phase: "work", secondsLeft: 20 });
  ok("the first set starts at 0% by definition (no elapsed time yet)", start === 0,
    "start of a 20s hold is genuinely 0%, got " + start);
  const mid = percentAt({ queue: q, stepIdx: 0, phase: "work", secondsLeft: 10 });
  ok("halfway through the first hold reads 13% (0.5 of 1/4)", mid === 13, "got " + mid);
  const done = percentAt({ queue: q, stepIdx: 0, phase: "work", secondsLeft: 0 });
  ok("a finished hold reads 25% before the set is even logged", done === 25, "got " + done);
}

/* --- 3. a timed hold moves live ---------------------------------- */
{
  const q = fourHolds();
  const a = percentAt({ queue: q, stepIdx: 1, phase: "work", secondsLeft: 20 });
  const b = percentAt({ queue: q, stepIdx: 1, phase: "work", secondsLeft: 15 });
  const c = percentAt({ queue: q, stepIdx: 1, phase: "work", secondsLeft: 10 });
  const d = percentAt({ queue: q, stepIdx: 1, phase: "work", secondsLeft: 5 });
  ok("the percentage climbs during a hold", a === 25 && b === 31 && c === 38 && d === 44,
    JSON.stringify([a, b, c, d]));
}

/* --- 4. a rep set counts only after FINISH SET ------------------- */
{
  const q = [repStep(), repStep(), repStep(), repStep()];
  const before = percentAt({ queue: q, stepIdx: 1, phase: "awaitingFinish", secondsLeft: 0 });
  const after = percentAt({ queue: q, stepIdx: 1, phase: "logSet" });
  ok("a rep set in progress earns nothing (1 of 4 done = 25%)", before === 25, "got " + before);
  ok("the same rep set counts once it is logged (50%)", after === 50, "got " + after);
}

/* --- 5. the final set reaches 100% ------------------------------- */
{
  const q = fourHolds();
  const lastWork = percentAt({ queue: q, stepIdx: 3, phase: "work", secondsLeft: 10 });
  const lastLog = percentAt({ queue: q, stepIdx: 3, phase: "logSet" });
  ok("the final set is not stuck below 100% while in progress", lastWork === 88, "got " + lastWork);
  ok("the final set reads 100% once it is logged", lastLog === 100, "got " + lastLog);

  const big = [];
  for (let i = 0; i < 20; i++) big.push(holdStep());
  ok("a 20-set day reads 100% on its final set (old code read 95%)",
    percentAt({ queue: big, stepIdx: 19, phase: "logSet" }) === 100);
}

/* --- 6. never goes backwards ------------------------------------- */
{
  const q = fourHolds();
  const script = [
    { phase: "windup", secondsLeft: 5 },
    { phase: "work", secondsLeft: 20 },
    { phase: "work", secondsLeft: 10 },
    { phase: "work", secondsLeft: 0 },
    { phase: "logSet", secondsLeft: 0 },
    { phase: "rest", secondsLeft: 60 },
    { phase: "rest", secondsLeft: 0 }
  ];
  const seen = [];
  for (let stepIdx = 0; stepIdx < q.length; stepIdx++) {
    script.forEach(s => seen.push(percentAt({ queue: q, stepIdx: stepIdx, phase: s.phase, secondsLeft: s.secondsLeft })));
  }
  let monotonic = true;
  for (let i = 1; i < seen.length; i++) if (seen[i] < seen[i - 1]) monotonic = false;
  ok("progress never decreases across a full session", monotonic, JSON.stringify(seen));
}

/* --- 7. pause freezes it ----------------------------------------- */
{
  const q = fourHolds();
  const running = percentAt({ queue: q, stepIdx: 1, phase: "work", secondsLeft: 10 });
  const paused = percentAt({ queue: q, stepIdx: 1, phase: "work", secondsLeft: 10, paused: true });
  ok("pausing does not change the percentage", running === paused, running + " vs " + paused);
}

/* --- 8. the UI shows that same number ---------------------------- */
{
  const q = fourHolds();
  ctx.state.view = "active";
  ctx.state.sessionStartTime = Date.now();

  ctx.state.queue = q; ctx.state.stepIdx = 1; ctx.state.phase = "work";
  ctx.state.secondsLeft = 10; ctx.state.paused = false;
  const midHtml = ctx.renderActive();
  ok("SESSION PROGRESS renders the live value (38%)", /SESSION PROGRESS[\s\S]{0,120}38%/.test(midHtml));
  ok("FINISH EARLY below the threshold says it will not count",
    /WON'T COUNT - 38%/.test(midHtml), "no 38% early-finish label");

  ctx.state.stepIdx = 2; ctx.state.phase = "logSet"; ctx.state.secondsLeft = 0;
  const highHtml = ctx.renderActive();
  ok("FINISH EARLY at 75% says it will count", /WILL COUNT - 75%/.test(highHtml));
  ok("both readouts agree on the same moment", /SESSION PROGRESS[\s\S]{0,120}75%/.test(highHtml));
}

/* --- summary ------------------------------------------------------ */
console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) { failures.forEach(f => console.log("  - " + f)); process.exit(1); }
process.exit(0);
