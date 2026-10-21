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
  /* timers are captured so a test can fire the "no reply" timeout by hand. */
  const timers = [];
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
    setTimeout: (fn, ms) => { timers.push({ fn: fn, ms: ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.cleared = true; },
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
  return { ctx: sandbox, html, store, openCalls, messageListeners, timers };
}

/* Drive every registered message listener as one window "message" event. */
function dispatchMessage(app, data) {
  const ev = { data };
  app.messageListeners.forEach(fn => fn(ev));
}

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
  ok("popup url carries token=", /[?&]token=sekret/.test(u), "<url redacted>");
  ok("popup target name is lockdSync", app.openCalls.length && app.openCalls[0].name === "lockdSync");
  ok("status shows the sync in flight", app.ctx.lockdStatusText() === "Syncing to laptop...", app.ctx.lockdStatusText());

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

/* ============================================================
   (f) task 8: queueing resets a stale status, sets + persists pending
   ============================================================ */
{
  const app = loadApp({
    "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" })
  });
  /* a stale "nothing to sync" from an earlier tap must not survive a
     fresh workout being queued (review Minor 1 - sticky status) */
  app.ctx.SYNC_STATUS = "Nothing to sync - log a session first.";
  app.ctx.queueLockdSync("workout");
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  const today = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  ok("queueing clears a stale SYNC_STATUS",
     app.ctx.lockdStatusText() === "Pending: " + today + " - tap SYNC",
     app.ctx.lockdStatusText());
  ok("queueing sets PENDING_SYNC",
     app.ctx.PENDING_SYNC && app.ctx.PENDING_SYNC.date === today && app.ctx.PENDING_SYNC.type === "workout",
     JSON.stringify(app.ctx.PENDING_SYNC));
  ok("queueing persists lockd-pending-sync",
     (function () {
       const raw = app.store["lockd-pending-sync"];
       if (!raw) return false;
       const p = JSON.parse(raw);
       return p.date === today && p.type === "workout";
     })(),
     String(app.store["lockd-pending-sync"]));
}

/* ============================================================
   (g) task 8: panel save path reads inputs -> laptopSync + storage
   ============================================================ */
{
  const app = loadApp({});
  app.ctx.document.getElementById("lockdUrlInput").value = "http://192.168.1.10:8787";
  app.ctx.document.getElementById("lockdTokenInput").value = "  sekret ";
  if (typeof app.ctx.saveLaptopSyncPanel === "function") app.ctx.saveLaptopSyncPanel();
  ok("panel save updates laptopSync (trimmed)",
     app.ctx.laptopSync && app.ctx.laptopSync.url === "http://192.168.1.10:8787" && app.ctx.laptopSync.token === "sekret",
     JSON.stringify(app.ctx.laptopSync));
  ok("panel save persists laptop-sync",
     (function () {
       const raw = app.store["laptop-sync"];
       if (!raw) return false;
       const cfg = JSON.parse(raw);
       return cfg.url === "http://192.168.1.10:8787" && cfg.token === "sekret";
     })(),
     String(app.store["laptop-sync"]));
  ok("panel save clears status and the app is configured",
     app.ctx.SYNC_STATUS === "" && app.ctx.SYNC_WAITING === false && app.ctx.lockdConfigured() === true,
     "status=" + app.ctx.SYNC_STATUS + " configured=" + app.ctx.lockdConfigured());
}

/* ============================================================
   (h) AUTO-SYNC: finishing a workout syncs by ITSELF.
   The popup must open SYNCHRONOUSLY inside logCompletion - only a
   user-initiated window.open survives the popup blocker, and
   logCompletion always runs inside the tap that ended the last set.
   ============================================================ */
const CFG = { "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" }) };

/* h1: the sync fires by itself when a workout is logged */
{
  const app = loadApp(Object.assign({}, CFG));
  app.ctx.logCompletion("MON", "workout");
  ok("logCompletion opens the sync popup with no tap on SYNC",
     app.openCalls.length === 1, "opens=" + app.openCalls.length);
  const u = app.openCalls.length ? app.openCalls[0].url : "";
  ok("auto-sync url carries today's date",
     u.indexOf("date=" + app.ctx.todayISO) > -1, u.replace(/token=[^&]*/, "token=<redacted>"));
  ok("auto-sync url carries type=workout", /[?&]type=workout/.test(u), u.replace(/token=[^&]*/, "token=<redacted>"));
  ok("the auto-sync popup reuses the lockdSync target",
     app.openCalls.length === 1 && app.openCalls[0].name === "lockdSync");
  ok("the finished session is queued as pending too",
     app.ctx.PENDING_SYNC && app.ctx.PENDING_SYNC.date === app.ctx.todayISO,
     JSON.stringify(app.ctx.PENDING_SYNC));
  ok("the token stays out of the visible status",
     app.ctx.lockdStatusText().indexOf("sekret") === -1, app.ctx.lockdStatusText());
}

/* h2: booting must never pop a window on its own */
{
  const app = loadApp({
    "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" }),
    "lockd-pending-sync": JSON.stringify({ date: "2026-10-19", type: "workout", at: "x" })
  });
  ok("booting the app opens no popup", app.openCalls.length === 0, "opens=" + app.openCalls.length);
}

/* h3: no configuration -> no popup, no noise */
{
  const app = loadApp({});
  app.ctx.logCompletion("MON", "workout");
  ok("not configured -> no popup", app.openCalls.length === 0, "opens=" + app.openCalls.length);
  ok("not configured -> nothing is queued",
     app.ctx.PENDING_SYNC === null, JSON.stringify(app.ctx.PENDING_SYNC));
  ok("not configured -> status stays quiet",
     app.ctx.lockdStatusText() === "Not configured", app.ctx.lockdStatusText());
}

/* h4: the user can switch auto-sync off */
{
  const app = loadApp(Object.assign({}, CFG));
  if (typeof app.ctx.setLockdAutoSync !== "function") {
    ok("auto-sync can be switched off", false, "setLockdAutoSync is missing");
  } else {
    app.ctx.setLockdAutoSync(false);
    app.ctx.logCompletion("MON", "workout");
    ok("auto-sync off -> no popup", app.openCalls.length === 0, "opens=" + app.openCalls.length);
    ok("auto-sync off -> the session is still queued for a manual sync",
       app.ctx.PENDING_SYNC && app.ctx.PENDING_SYNC.date === app.ctx.todayISO,
       JSON.stringify(app.ctx.PENDING_SYNC));
    ok("auto-sync off persists to storage", app.store["lockd-auto-sync"] === "0",
       String(app.store["lockd-auto-sync"]));
    app.ctx.setLockdAutoSync(true);
    app.ctx.logCompletion("TUE", "workout");
    ok("auto-sync back on -> popup again", app.openCalls.length === 1, "opens=" + app.openCalls.length);
    ok("auto-sync on persists to storage", app.store["lockd-auto-sync"] === "1",
       String(app.store["lockd-auto-sync"]));
  }
}

/* h5: a sync already in flight is not interrupted by a second popup */
{
  const app = loadApp(Object.assign({}, CFG));
  app.ctx.logCompletion("MON", "workout");
  app.ctx.logCompletion("TUE", "workout");
  ok("a sync in flight is not double-poked", app.openCalls.length === 1, "opens=" + app.openCalls.length);
}

/* h6: a blocked popup leaves an actionable status */
{
  const app = loadApp(Object.assign({}, CFG), { returnValue: null });
  app.ctx.logCompletion("MON", "workout");
  ok("blocked auto-sync -> retry status",
     app.ctx.lockdStatusText() === "Popup blocked - tap SYNC to retry.",
     app.ctx.lockdStatusText());
  ok("blocked auto-sync -> not waiting", app.ctx.SYNC_WAITING === false);
}

/* h7: the overview retries a sync that was blocked */
{
  const app = loadApp(Object.assign({}, CFG), { returnValue: null });
  app.ctx.logCompletion("MON", "workout");
  const before = app.openCalls.length;
  app.ctx.returnFromComplete();
  ok("returning to the overview retries the blocked sync",
     app.openCalls.length === before + 1, "opens=" + app.openCalls.length + " before=" + before);
}

/* h8: no reply from the laptop -> the status says so instead of hanging */
{
  const app = loadApp(Object.assign({}, CFG));
  app.ctx.logCompletion("MON", "workout");
  app.timers.forEach(t => { if (!t.cleared) t.fn(); });
  ok("no reply -> the sync stops waiting", app.ctx.SYNC_WAITING === false);
  ok("no reply -> actionable status",
     /no reply/i.test(app.ctx.lockdStatusText()), app.ctx.lockdStatusText());
}

/* h9: the completion screen tells the truth about the sync */
{
  const app = loadApp(Object.assign({}, CFG));
  app.ctx.logCompletion("MON", "workout");
  app.ctx.state.view = "complete";
  const syncingHtml = app.ctx.renderComplete();
  ok("completion screen shows the syncing state", /SYNCING TO LAPTOP/i.test(syncingHtml),
     "headline missing from the completion screen");
  ok("completion screen keeps a manual retry button",
     syncingHtml.indexOf('onclick="syncToLaptop()"') > -1, "no manual sync button");
  dispatchMessage(app, { source: "lockd", status: "ok", date: app.ctx.todayISO, type: "workout" });
  const okHtml = app.ctx.renderComplete();
  ok("completion screen shows the unlocked headline", /GAMES UNLOCKED/i.test(okHtml),
     "headline missing from the completion screen");
  ok("completion screen shows the logged date",
     okHtml.indexOf(app.ctx.todayISO) > -1, "no date on the completion screen");
}

/* --- summary ------------------------------------------------------- */
console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) {
  console.log("failures:");
  failures.forEach(f => console.log(" - " + f));
  process.exit(1);
}
