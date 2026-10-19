"use strict";
/* ============================================================
   Training Console - laptop sync (lockd) behavioural tests
   Run:  node tests/lockd-sync.test.js
   Exit code 0 = all green, 1 = failures.

   Boots the REAL inline script in a browser stub sandbox (same
   technique as difficulty-normal.test.js) and asserts the sync
   engine at BEHAVIOUR level - not by grepping index.html source.

   Guards the bug class the source-text harness missed:
   - the pending sync being reset to null on every boot (BLOCKER)
   - syncToLaptop fabricating a sync for an untrained day (MAJOR)
   - wrong pending lifecycle per daemon status (ok/stale/denied)
   - stale/future popup results clobbering a different pending
   - scheme-less / whitespace config silently failing in window.open
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
function loadApp(seedStore, openRecorder) {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (scripts.length !== 1) throw new Error("expected exactly one inline script, found " + scripts.length);
  const src = scripts[0];

  const store = seedStore || {};
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

  /* window records open() calls and postMessage listeners so tests can
     drive the popup handshake without a real browser. */
  const openCalls = [];
  const messageListeners = [];
  const windowStub = {
    location: { reload() {} },
    performance: { now: () => Date.now() },
    open(url, name, features) {
      openCalls.push({ url, name, features });
      return (openRecorder && openRecorder.returnValue !== undefined) ? openRecorder.returnValue : { closed: false };
    },
    addEventListener(type, fn) { if (type === "message") messageListeners.push(fn); },
    removeEventListener() {}
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
  return { ctx: sandbox, html, store, openCalls, messageListeners };
}

/* Drive every registered message listener as one window "message" event. */
function dispatchMessage(app, data) {
  const ev = { data };
  app.messageListeners.forEach(fn => fn(ev));
}

const TODAY = (function () {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
})();

/* ============================================================
   (a) BLOCKER regression: a seeded pending sync survives boot
   ============================================================ */
{
  const seeded = { date: "2026-10-19", type: "workout", at: "2026-10-19T18:00:00.000Z" };
  const app = loadApp({ "lockd-pending-sync": JSON.stringify(seeded) });
  ok("boot restores PENDING_SYNC from storage",
     app.ctx.PENDING_SYNC && app.ctx.PENDING_SYNC.date === seeded.date,
     JSON.stringify(app.ctx.PENDING_SYNC));
  ok("boot keeps the pending type",
     app.ctx.PENDING_SYNC && app.ctx.PENDING_SYNC.type === "workout",
     JSON.stringify(app.ctx.PENDING_SYNC));
  ok("lockdStatusText reports the restored pending",
     app.ctx.lockdStatusText() === "Pending: " + seeded.date + " - tap SYNC",
     app.ctx.lockdStatusText());
}

/* ============================================================
   (b) MAJOR: no pending -> syncToLaptop opens NO window
   ============================================================ */
{
  const app = loadApp({
    "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" })
  });
  app.ctx.syncToLaptop();
  ok("no pending -> opens no window", app.openCalls.length === 0, "opens=" + app.openCalls.length);
  ok("no pending -> shows the nothing-to-sync status",
     app.ctx.lockdStatusText() === "Nothing to sync - log a session first.",
     app.ctx.lockdStatusText());
}

/* ============================================================
   (c) pending -> syncToLaptop opens exactly one window, token in URL only
   ============================================================ */
{
  const app = loadApp({
    "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" }),
    "lockd-pending-sync": JSON.stringify({ date: "2026-10-19", type: "boulder", at: "2026-10-19T18:00:00.000Z" })
  });
  app.ctx.syncToLaptop();
  ok("pending -> opens exactly one window", app.openCalls.length === 1, "opens=" + app.openCalls.length);
  const u = app.openCalls.length ? app.openCalls[0].url : "";
  ok("popup url carries date=", /[?&]date=2026-10-19/.test(u), u.replace(/token=[^&]*/, "token=<redacted>"));
  ok("popup url carries type=boulder", /[?&]type=boulder/.test(u), u.replace(/token=[^&]*/, "token=<redacted>"));
  ok("popup url carries token=", /[?&]token=/.test(u), "<url redacted>");
  ok("popup target name is lockdSync", app.openCalls.length && app.openCalls[0].name === "lockdSync");
  ok("status shows Waiting...", app.ctx.lockdStatusText() === "Waiting...", app.ctx.lockdStatusText());

  /* token must not leak into any other string the app exposes */
  ok("token absent from lockdStatusText", app.ctx.lockdStatusText().indexOf("sekret") === -1);
}

/* blocked popup -> retry status, no crash */
{
  const app = loadApp({
    "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" }),
    "lockd-pending-sync": JSON.stringify({ date: "2026-10-19", type: "workout", at: "x" })
  }, { returnValue: null });
  app.ctx.syncToLaptop();
  ok("blocked popup -> retry status",
     app.ctx.lockdStatusText() === "Popup blocked - tap SYNC to retry.",
     app.ctx.lockdStatusText());
}

/* ============================================================
   (d) message listener
   ============================================================ */
function appWithPending(status, msgDate) {
  const app = loadApp({
    "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" }),
    "lockd-pending-sync": JSON.stringify({ date: "2026-10-19", type: "workout", at: "x" })
  });
  dispatchMessage(app, { source: "lockd", status, date: msgDate || "2026-10-19", type: "workout" });
  return app;
}

{
  const app = appWithPending("ok");
  ok("ok clears pending", app.ctx.PENDING_SYNC === null, JSON.stringify(app.ctx.PENDING_SYNC));
  ok("ok clears stored pending",
     app.store["lockd-pending-sync"] === "" || app.store["lockd-pending-sync"] == null,
     String(app.store["lockd-pending-sync"]));
  ok("ok shows Logged line",
     app.ctx.lockdStatusText() === "Logged 2026-10-19 (workout).",
     app.ctx.lockdStatusText());
}

{
  const app = appWithPending("denied");
  ok("denied KEEPS pending", app.ctx.PENDING_SYNC !== null && app.ctx.PENDING_SYNC.date === "2026-10-19",
     JSON.stringify(app.ctx.PENDING_SYNC));
  ok("denied shows a visible error",
     /denied/i.test(app.ctx.lockdStatusText()) && app.ctx.lockdStatusText().indexOf("sekret") === -1,
     app.ctx.lockdStatusText());
}

{
  const app = appWithPending("stale");
  ok("stale clears pending", app.ctx.PENDING_SYNC === null, JSON.stringify(app.ctx.PENDING_SYNC));
  ok("stale shows the expired notice",
     app.ctx.lockdStatusText() === "That date has expired - log today's session again.",
     app.ctx.lockdStatusText());
}

{
  const app = loadApp({
    "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" }),
    "lockd-pending-sync": JSON.stringify({ date: "2026-10-19", type: "workout", at: "x" })
  });
  dispatchMessage(app, { source: "evil", status: "ok", date: "2026-10-19", type: "workout" });
  ok("foreign source ignored (pending kept)",
     app.ctx.PENDING_SYNC !== null && app.ctx.PENDING_SYNC.date === "2026-10-19",
     JSON.stringify(app.ctx.PENDING_SYNC));
}

{
  const app = loadApp({
    "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" }),
    "lockd-pending-sync": JSON.stringify({ date: "2026-10-19", type: "workout", at: "x" })
  });
  dispatchMessage(app, { source: "lockd", status: "ok", date: "2026-10-18", type: "workout" });
  ok("mismatched date ignored (pending kept)",
     app.ctx.PENDING_SYNC !== null && app.ctx.PENDING_SYNC.date === "2026-10-19",
     JSON.stringify(app.ctx.PENDING_SYNC));
}

/* ============================================================
   (e) config validation
   ============================================================ */
{
  function configured(cfg) {
    return loadApp(cfg ? { "laptop-sync": JSON.stringify(cfg) } : {}).ctx.lockdConfigured();
  }
  ok("empty config -> not configured", configured(null) === false);
  ok("whitespace url/token -> not configured", configured({ url: "   ", token: "  " }) === false);
  ok("scheme-less url -> not configured", configured({ url: "192.168.1.10:8787", token: "sekret" }) === false);
  ok("missing token -> not configured", configured({ url: "http://192.168.1.10:8787", token: "" }) === false);
  ok("proper http url + token -> configured", configured({ url: "http://192.168.1.10:8787", token: "sekret" }) === true);
  ok("https url + token -> configured", configured({ url: "https://host:8787", token: "sekret" }) === true);
}

/* --- summary ------------------------------------------------------- */
console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) {
  console.log("failures:");
  failures.forEach(f => console.log(" - " + f));
  process.exit(1);
}
