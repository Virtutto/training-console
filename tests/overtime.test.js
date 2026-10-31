"use strict";
/* ============================================================
   Training Console - overtime stopwatch (v8.5)
   Run:  node tests/overtime.test.js
   Exit code 0 = all green, 1 = failures.

   A timed hold that runs past its target must NOT be logged
   automatically. It enters an "overtime" phase with a stopwatch,
   and STOP hands the target-plus-overtime total to the normal
   LOG THIS SET screen as an editable pre-fill.

   Boots the REAL inline script in a browser stub sandbox (same
   technique as calib-variant.test.js and progress.test.js) and
   asserts behaviour, not source text.
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
  const storageWrites = [];
  function el(id) {
    if (!elements[id]) {
      elements[id] = {
        id, innerHTML: "", value: "", textContent: "", href: "", className: "",
        style: {}, dataset: {}, attrs: {},
        click() {}, focus() {}, blur() {}, remove() {},
        closest() { return null; }, querySelector() { return null; },
        addEventListener() {}, appendChild() {}, setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null; }
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
    localStorage: {
      getItem() { return null; },
      setItem(k, v) { storageWrites.push({ key: k, value: v }); },
      removeItem() {}
    },
    navigator: navigatorStub,
    window: windowStub,
    console,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    alert() {},
    confirm: () => false,
    performance: { now: () => Date.now() }
  };
  windowStub.AudioContext = undefined;
  windowStub.webkitAudioContext = undefined;
  sandbox.globalThis = sandbox;
  sandbox.__elements = elements;
  sandbox.__storageWrites = storageWrites;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "index-inline.js" });
  return sandbox;
}

const ctx = loadApp();

/* --- fixtures ----------------------------------------------------- */
function holdStep(over) {
  return Object.assign({
    section: "MAIN", name: "Test hold", setIndex: 1, setTotal: 2,
    type: "time", duration: 20, repsLabel: null, cue: "", restAfter: 60
  }, over || {});
}
function repStep(over) {
  return Object.assign({
    section: "MAIN", name: "Test reps", setIndex: 1, setTotal: 2,
    type: "reps", duration: undefined, repsLabel: "5 reps", cue: "", restAfter: 60
  }, over || {});
}

function arm(phase, over) {
  ctx.state.view = "active";
  ctx.state.queue = [holdStep(), holdStep()];
  ctx.state.stepIdx = 0;
  ctx.state.phase = phase;
  ctx.state.paused = false;
  ctx.state.secondsLeft = 0;
  ctx.state.phaseEndTime = null;
  ctx.state.phaseSeconds = null;
  ctx.state.overtimeStart = null;
  ctx.state.overtimePausedAt = null;
  ctx.state.overtimeSeconds = 0;
  ctx.state.overtimeMeasured = null;
  ctx.state.overtimeOver = null;
  ctx.state.setLogs = [];
  ctx.state.sessionLog = [];
  Object.assign(ctx.state, over || {});
}

function lastSetLogWrite() {
  for (let i = ctx.__storageWrites.length - 1; i >= 0; i--) {
    if (ctx.__storageWrites[i].key === "set-log") return ctx.__storageWrites[i];
  }
  return null;
}

/* --- 1. the hold ending enters overtime, not the log screen ------ */
{
  arm("work", { secondsLeft: 0 });
  const before = ctx.state.setLogs.length;
  ctx.advancePhase();
  ok("a timed hold at zero enters overtime", ctx.state.phase === "overtime", "phase=" + ctx.state.phase);
  ok("the stopwatch has a start moment", typeof ctx.state.overtimeStart === "number" && ctx.state.overtimeStart > 0,
    String(ctx.state.overtimeStart));
  ok("nothing is logged on entering overtime", ctx.state.setLogs.length === before,
    before + " -> " + ctx.state.setLogs.length);
  ok("no set-log write happens on entering overtime", lastSetLogWrite() === null);
}

/* --- 2. the stopwatch counts the extra seconds ------------------- */
{
  arm("overtime", { overtimeStart: Date.now() - 7000 });
  const secs = ctx.overtimeElapsedSeconds();
  ok("the stopwatch reads the seconds actually held over", secs === 7, "got " + secs);

  ctx.state.phase = "overtime";
  ctx.state.overtimeStart = Date.now() - 30000;
  ok("it keeps counting with no cap", ctx.overtimeElapsedSeconds() === 30, "got " + ctx.overtimeElapsedSeconds());
}

/* --- 3. STOP hands over an editable total, without logging ------- */
{
  arm("overtime", { overtimeStart: Date.now() - 7000 });
  ctx.stopOvertime();
  ok("STOP lands on the log screen", ctx.state.phase === "logSet", "phase=" + ctx.state.phase);
  ok("the measured total is target plus overtime", ctx.state.overtimeMeasured === 27,
    String(ctx.state.overtimeMeasured));
  ok("the overtime itself is kept for the breakdown", ctx.state.overtimeOver === 7,
    String(ctx.state.overtimeOver));
  ok("STOP writes nothing to the set log", ctx.state.setLogs.length === 0 && lastSetLogWrite() === null);

  const html = ctx.renderActive();
  ok("the seconds field is pre-filled with the total",
    /id="actualDurationInput"[^>]*value="27"/.test(html), "no value=\"27\" on the input");
  ok("the field is no longer clamped to the target",
    !/id="actualDurationInput"[^>]*max="/.test(html), "input still carries a max");
  ok("the panel shows the target plus the overtime", /20s \+ 7s OVER/.test(html),
    "breakdown missing");
}

/* --- 4. logging more than the target is possible now ------------- */
{
  arm("logSet", { overtimeMeasured: 27, overtimeOver: 7 });
  ctx.document.getElementById("actualDurationInput").value = "27";
  ctx.recordSetLog("normal");
  const logs = ctx.state.setLogs;
  ok("a hold above target is stored as measured",
    logs.length === 1 && logs[0].actualDuration === 27,
    JSON.stringify(logs.length ? logs[0] : null));
  ok("the pre-fill is cleared after logging so the next set is clean",
    ctx.state.overtimeMeasured === null && ctx.state.overtimeOver === null,
    JSON.stringify([ctx.state.overtimeMeasured, ctx.state.overtimeOver]));
}

/* --- 5. pre-fill never outlives its set ------------------------- */
{
  arm("logSet", {});
  ctx.document.getElementById("actualDurationInput").value = "";
  ctx.recordSetLog("normal");
  const logs = ctx.state.setLogs;
  ok("a plain hold with an empty field still logs the target",
    logs.length === 1 && logs[0].actualDuration === 20, JSON.stringify(logs.length ? logs[0] : null));
}

/* --- 6. rep sets never enter overtime --------------------------- */
{
  ctx.state.view = "active";
  ctx.state.queue = [repStep(), repStep()];
  ctx.state.stepIdx = 0;
  ctx.state.phase = "work";
  ctx.state.paused = false;
  ctx.state.overtimeStart = null;
  ctx.state.setLogs = [];
  ctx.advancePhase();
  ok("a rep set goes straight to the log screen", ctx.state.phase === "logSet", "phase=" + ctx.state.phase);
  ok("a rep set never starts a stopwatch", ctx.state.overtimeStart === null, String(ctx.state.overtimeStart));
}

/* --- 7. pause freezes the stopwatch ----------------------------- */
{
  arm("overtime", { overtimeStart: Date.now() - 5000 });
  ctx.togglePause();
  ok("pausing records the moment", typeof ctx.state.overtimePausedAt === "number",
    String(ctx.state.overtimePausedAt));
  const frozen = ctx.overtimeElapsedSeconds();
  ok("the stopwatch is frozen while paused", ctx.overtimeElapsedSeconds() === frozen, "got " + frozen);

  /* Pretend the pause lasted four seconds, then resume. */
  ctx.state.overtimePausedAt = Date.now() - 4000;
  ctx.togglePause();
  const shifted = Date.now() - ctx.state.overtimeStart;
  ok("resuming drops the paused time from the stopwatch", shifted < 7000,
    "overtimeStart moved only " + shifted + "ms into the past (paused time not excluded)");
  ok("pausing clears the pause marker on resume", ctx.state.overtimePausedAt === null,
    String(ctx.state.overtimePausedAt));
}

/* --- 8. progress counts overtime as a finished step -------------- */
{
  const q = [holdStep(), holdStep(), holdStep(), holdStep()];
  function pct(phase) {
    ctx.state.queue = q; ctx.state.stepIdx = 1; ctx.state.phase = phase; ctx.state.secondsLeft = 0;
    return ctx.sessionProgressPercent();
  }
  ok("overtime counts like a logged step", pct("overtime") === pct("logSet"),
    pct("overtime") + " vs " + pct("logSet"));
}

/* --- 9. the ring and the copy follow the phase ------------------- */
{
  arm("overtime", { overtimeStart: Date.now() - 12000 });
  const html = ctx.renderActive();
  ok("overtime is labelled", /OVERTIME/.test(html), "no OVERTIME label");
  ok("overtime uses the amber accent", /#ffb547/i.test(html), "amber missing");
  ok("overtime offers STOP", /STOP/.test(html), "no STOP control");
  ok("overtime does not offer SKIP", !/>\s*SKIP\s*</.test(html), "SKIP still offered");
}

/* --- summary ------------------------------------------------------ */
console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) { failures.forEach(f => console.log("  - " + f)); process.exit(1); }
process.exit(0);
