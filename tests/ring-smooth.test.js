"use strict";
/* ============================================================
   Training Console - smooth timer ring (v8.5)
   Run:  node tests/ring-smooth.test.js
   Exit code 0 = all green, 1 = failures.

   The old arc was positioned from whole seconds and animated by a
   1s CSS transition that a 250ms re-render restarted every time, so
   it snapped once per second. v8.5 positions the arc from the phase
   end timestamp inside requestAnimationFrame.

   Boots the REAL inline script in a browser stub sandbox and drives
   the frame function by hand.
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
        style: {}, dataset: {}, attrs: {},
        click() {}, focus() {}, blur() {}, remove() {},
        closest() { return null; }, querySelector() { return null; },
        addEventListener() {}, appendChild() {},
        setAttribute(k, v) { this.attrs[k] = String(v); },
        /* The real SVG element carries r="115" (240px ring, 10px stroke). */
        getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : (k === "r" ? "115" : null); }
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

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "index-inline.js" });
  return sandbox;
}

const ctx = loadApp();
const CIRC = 2 * Math.PI * 115;

function holdStep(over) {
  return Object.assign({
    section: "MAIN", name: "Test hold", setIndex: 1, setTotal: 2,
    type: "time", duration: 20, repsLabel: null, cue: "", restAfter: 60
  }, over || {});
}

function armActive(over) {
  ctx.state.view = "active";
  ctx.state.queue = [holdStep(), holdStep()];
  ctx.state.stepIdx = 0;
  ctx.state.phase = "work";
  ctx.state.paused = false;
  ctx.state.secondsLeft = 20;
  ctx.state.phaseSeconds = 20;
  ctx.state.phaseEndTime = Date.now() + 20000;
  Object.assign(ctx.state, over || {});
}

/* --- 1. the markup the frame loop writes to --------------------- */
{
  const svg = ctx.ringSVG(0.5, "#00e5ff", "rgba(0,229,255,0.35)", 240, 10, "x");
  ok("the arc carries a stable id", /id="ringArc"/.test(svg), "no ringArc id");
  ok("the arc no longer uses a CSS transition", !/transition\s*:\s*stroke-dashoffset/.test(svg),
    "transition still present on the arc");

  armActive({});
  const html = ctx.renderActive();
  ok("the centre number carries a stable id", /id="ringNum"/.test(html), "no ringNum id");
}

/* --- 2. a mid-second frame is fractional ------------------------ */
{
  const now = Date.now();
  armActive({ phaseEndTime: now + 10500 });
  const p = ctx.ringProgressAt(now);
  ok("progress at 10.5s of a 20s hold is 47.5%", Math.abs(p - 0.475) < 0.002, "got " + p);

  const arc = ctx.document.getElementById("ringArc");
  ok("the arc element exists in the DOM stub", !!arc, "no ringArc element");
  ctx.applyRingFrame();

  const written = parseFloat(arc.attrs["stroke-dashoffset"]);
  const expected = CIRC * (1 - 0.475);
  ok("the frame writes a fractional dash offset", Math.abs(written - expected) < 8,
    "wrote " + written + ", expected about " + expected);

  const wholeSecond = CIRC / 20;
  const offWhole = Math.abs(written % wholeSecond);
  ok("the offset is not snapped to a whole second",
    offWhole > 1 && Math.abs(offWhole - wholeSecond) > 1,
    "offset " + written + " sits on a one-second step");
}

/* --- 3. pause freezes the arc ---------------------------------- */
{
  const now = Date.now();
  armActive({ phaseEndTime: now + 8000, paused: true });
  const arc = ctx.document.getElementById("ringArc");
  ctx.applyRingFrame();
  const first = arc.attrs["stroke-dashoffset"];
  ctx.applyRingFrame();
  const second = arc.attrs["stroke-dashoffset"];
  ok("a paused frame leaves the arc alone", first === second, first + " -> " + second);
}

/* --- 4. overtime is a full ring -------------------------------- */
{
  armActive({ phase: "overtime", phaseEndTime: null });
  ctx.applyRingFrame();
  const arc = ctx.document.getElementById("ringArc");
  const written = parseFloat(arc.attrs["stroke-dashoffset"]);
  ok("overtime holds the ring full", written < 0.5, "offset " + written);
}

/* --- 5. the loop starts and stops cleanly ---------------------- */
{
  ok("startRingAnimation is defined", typeof ctx.startRingAnimation === "function");
  ok("stopRingAnimation is defined", typeof ctx.stopRingAnimation === "function");
  ctx.state.paused = false;
  ctx.startRingAnimation();
  ok("starting arms a frame handle", ctx.ringRafId !== null && ctx.ringRafId !== undefined,
    String(ctx.ringRafId));
  ctx.stopRingAnimation();
  ok("stopping clears the frame handle", ctx.ringRafId === null, String(ctx.ringRafId));
}

/* --- summary ------------------------------------------------------ */
console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) { failures.forEach(f => console.log("  - " + f)); process.exit(1); }
process.exit(0);
