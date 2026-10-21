"use strict";
/* ============================================================
   Training Console - calibration VARIANT GATE (v8.3)
   Run:  node tests/calib-variant.test.js
   Exit code 0 = all green, 1 = failures.

   The plan now prescribes a SPECIFIC variant of two movements:
   the one-leg hollow (20s) and the band-assisted tuck lever (12s).
   A battery result measured on a DIFFERENT variant of the same
   movement describes a different exercise, so it must not be
   applied to the plan - and the review screen must not promise a
   change that the engine will refuse to make.

   Boots the REAL inline script in a browser stub sandbox (same
   technique as lockd-sync.test.js) and asserts behaviour, not
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

/* --- helpers ------------------------------------------------------ */
function batteryTest(ctx, id) { return ctx.BATTERY.filter(b => b.id === id)[0]; }
function rowFor(ctx, id) { return ctx.calibReviewRows().filter(r => r.id === id)[0]; }

/* A battery result for a hold test: attempts in seconds + the variant used. */
function holdResult(attempts, variant) { return { attempts: attempts, variant: variant }; }

/* Run the review screen against a fresh app with the given results. */
function reviewWith(ctx, results) {
  ctx.state.calib = { date: "2026-10-21", phase: "review", results: results };
  ctx.state.planCalibration = null;
  return ctx.calibReviewRows();
}

const ctx = loadApp();

/* ============================================================
   (a) the battery default must be the variant the plan uses
   ============================================================ */
{
  const hollow = batteryTest(ctx, "hollow");
  const lever = batteryTest(ctx, "tucklever");
  ok("the hollow battery defaults to the one-leg variation",
    hollow && hollow.variants[0] === "one-leg", hollow ? hollow.variants.join(",") : "no hollow test");
  ok("the hollow battery offers the one-leg variation",
    hollow && hollow.variants.indexOf("one-leg") > -1, hollow ? hollow.variants.join(",") : "no hollow test");
  ok("the tuck lever battery defaults to the band-assisted variation",
    lever && lever.variants[0] === "band-assisted tuck", lever ? lever.variants.join(",") : "no lever test");
  ok("the tuck lever battery offers the band-assisted variation",
    lever && lever.variants.indexOf("band-assisted tuck") > -1, lever ? lever.variants.join(",") : "no lever test");
}

/* ============================================================
   (b) the review screen: a matching variant is a normal change
   ============================================================ */
{
  const rows = reviewWith(ctx, {
    hollow: holdResult([26], "one-leg"),
    tucklever: holdResult([24], "band-assisted tuck")
  });
  const h = rowFor(ctx, "hollow");
  const t = rowFor(ctx, "tucklever");
  ok("a one-leg hollow result is offered as a change (20s -> 18s)",
    h && h.now === "20s" && h.next === "18s", h ? h.now + " -> " + h.next : "no row");
  ok("a one-leg hollow result carries no variant conflict",
    h && !h.conflict, h ? String(h.conflict) : "no row");
  ok("a band-assisted tuck result is offered as a change (12s -> 13s)",
    t && t.now === "12s" && t.next === "13s", t ? t.now + " -> " + t.next : "no row");
  ok("a band-assisted tuck result carries no variant conflict",
    t && !t.conflict, t ? String(t.conflict) : "no row");
}

/* ============================================================
   (b2) the review header counts REAL changes only
   ============================================================ */
{
  const app2 = loadApp();
  app2.state.calib = { date: "2026-10-21", phase: "review", results: {
    hollow: { attempts: [26], variant: "one-leg" },
    tucklever: { attempts: [24], variant: "band-assisted tuck" }
  } };
  app2.state.planCalibration = null;
  const html = app2.renderCalibration();
  ok("the review header counts the two real changes",
    /2 of 10 movements would change/.test(html), (html.match(/\d+ of 10 movements would change/) || [])[0]);
  ok("an unmeasured movement is not counted as a change",
    !/8 of 10 movements would change/.test(html) && !/10 of 10 movements would change/.test(html),
    (html.match(/\d+ of 10 movements would change/) || [])[0]);
}

/* ============================================================
   (c) the review screen: a DIFFERENT variant is not a change
   ============================================================ */
{
  const rows = reviewWith(ctx, {
    hollow: holdResult([26], "arms at sides"),
    tucklever: holdResult([24], "tuck")
  });
  const h = rowFor(ctx, "hollow");
  const t = rowFor(ctx, "tucklever");
  ok("a two-leg hollow result does NOT promise a change (now == next)",
    h && h.now === h.next, h ? h.now + " -> " + h.next : "no row");
  ok("a two-leg hollow result is flagged as a variant conflict",
    h && h.conflict === "Hollow body hold (arms at sides)", h ? String(h.conflict) : "no row");
  ok("a plain-tuck result does NOT promise a change (now == next)",
    t && t.now === t.next, t ? t.now + " -> " + t.next : "no row");
  ok("a plain-tuck result is flagged as a variant conflict",
    t && t.conflict === "Tuck front lever holds", t ? String(t.conflict) : "no row");
}

/* ============================================================
   (d) the engine and the review screen agree
   ============================================================ */
{
  const app2 = loadApp();
  app2.state.planCalibration = { planVersion: app2.APP_VERSION, doses: {
    hollow: { duration: 18, variant: "arms at sides" },
    tucklever: { duration: 13, variant: "tuck" }
  } };
  const wed = app2.buildQueue("Wednesday");
  const hollow = wed.filter(q => q.name.indexOf("hollow") > -1);
  const lever = wed.filter(q => q.name.indexOf("lever") > -1);
  ok("a two-leg hollow dose leaves the plan hollow at 20s",
    hollow.length > 0 && hollow.every(q => q.duration === 20 && q.name === "One-leg hollow body hold"),
    JSON.stringify(hollow.map(q => q.name + "=" + q.duration)));
  ok("a plain-tuck dose leaves the plan lever at 12s",
    lever.length > 0 && lever.every(q => q.duration === 12 && q.name === "Band-assisted tuck front lever holds"),
    JSON.stringify(lever.map(q => q.name + "=" + q.duration)));
}

/* ============================================================
   (e) a matching variant dose DOES apply
   ============================================================ */
{
  const app3 = loadApp();
  app3.state.planCalibration = { planVersion: app3.APP_VERSION, doses: {
    hollow: { duration: 18, variant: "one-leg" },
    tucklever: { duration: 13, variant: "band-assisted tuck" }
  } };
  const wed = app3.buildQueue("Wednesday");
  const hollow = wed.filter(q => q.name.indexOf("hollow") > -1);
  const lever = wed.filter(q => q.name.indexOf("lever") > -1);
  ok("a one-leg hollow dose applies to the plan hollow (18s)",
    hollow.length > 0 && hollow.every(q => q.duration === 18 && q.name === "One-leg hollow body hold"),
    JSON.stringify(hollow.map(q => q.name + "=" + q.duration)));
  ok("a band-assisted tuck dose applies to the plan lever (13s)",
    lever.length > 0 && lever.every(q => q.duration === 13 && q.name === "Band-assisted tuck front lever holds"),
    JSON.stringify(lever.map(q => q.name + "=" + q.duration)));
}

/* ============================================================
   (f) the conflict helper on its own
   ============================================================ */
{
  ok("calibVariantConflict exists", typeof ctx.calibVariantConflict === "function");
  if (typeof ctx.calibVariantConflict === "function") {
    ok("a mismatched hollow variant is a conflict",
      ctx.calibVariantConflict("hollow", "One-leg hollow body hold", "arms at sides") === "Hollow body hold (arms at sides)");
    ok("a matching hollow variant is not a conflict",
      ctx.calibVariantConflict("hollow", "One-leg hollow body hold", "one-leg") === null);
    ok("a mismatched tuck variant is a conflict",
      ctx.calibVariantConflict("tucklever", "Band-assisted tuck front lever holds", "tuck") === "Tuck front lever holds");
    ok("a matching tuck variant is not a conflict",
      ctx.calibVariantConflict("tucklever", "Band-assisted tuck front lever holds", "band-assisted tuck") === null);
    ok("an exercise that is not a named variant never conflicts",
      ctx.calibVariantConflict("hollow", "Hollow hold (light)", "arms at sides") === null);
    ok("no measured variant never conflicts",
      ctx.calibVariantConflict("hollow", "One-leg hollow body hold", null) === null);
  }
}

console.log("");
console.log(pass + " passed, " + failures.length + " failed");
if (failures.length) {
  console.log("failures:");
  failures.forEach(f => console.log("  - " + f));
}
process.exit(failures.length ? 1 : 0);
