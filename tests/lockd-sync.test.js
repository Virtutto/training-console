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
function loadApp(seedStore, openRecorder, fetchRecorder, hash) {
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
  /* fetch is recorded, and driven by fetchRecorder: {status, mode:"throw"}.
     The relay path is the only thing in the app that fetches, and it must be
     testable without a network. */
  const fetchCalls = [];
  const replaceCalls = [];
  const fetchPlan = fetchRecorder || {};
  function fetchStub(url, opts) {
    fetchCalls.push({ url: url, opts: opts || {} });
    if (fetchPlan.mode === "throw") return Promise.reject(new Error(fetchPlan.message || "network down"));
    const status = fetchPlan.status === undefined ? 200 : fetchPlan.status;
    return Promise.resolve({ ok: status >= 200 && status < 300, status: status });
  }
  /* timers are captured so a test can fire the "no reply" timeout by hand. */
  const timers = [];
  /* The app reads `location` and `history` as bare globals, so they belong on the
     sandbox root as well as on window. */
  const locationStub = { reload() {}, hash: hash || "", pathname: "/training-console/", search: "" };
  const historyStub = { replaceState(a, b, url) { replaceCalls.push(url); } };
  const windowStub = {
    location: locationStub,
    history: historyStub,
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
    location: locationStub,
    history: historyStub,
    console,
    fetch: fetchStub,
    crypto: crypto,
    TextEncoder: TextEncoder,
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
  return { ctx: sandbox, html, store, openCalls, messageListeners, timers, fetchCalls, replaceCalls };
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

/* ============================================================
   (i) the 2-second in-app toast when a sync resolves
   ============================================================ */
/* Adam: "an in app pop up for like 2 seconds when the autosync happens".
   The popup window is the daemon's page; this is the console's own
   receipt, so it must live in the app and clear itself. */
{
  const app = appWithPending("ok");
  const toast = app.ctx.state.syncToast;
  ok("a successful sync raises an in-app toast", !!toast, JSON.stringify(toast));
  ok("the toast leads with GAMES UNLOCKED", toast && toast.headline === "GAMES UNLOCKED",
     toast ? toast.headline : "no toast");
  ok("the toast is rendered into the app",
     app.ctx.document.getElementById("app").innerHTML.indexOf("sync-toast") > -1,
     "no .sync-toast in the rendered app");
  ok("the toast names the synced date",
     toast && toast.detail.indexOf("2026-10-19") > -1,
     toast ? toast.detail : "no toast");

  const toastTimers = app.timers.filter(t => t.ms === 2000 && !t.cleared);
  ok("the toast is armed to clear after 2 seconds", toastTimers.length === 1,
     "timers=" + app.timers.map(t => t.ms).join(","));
  if (toastTimers.length) toastTimers[0].fn();
  ok("after 2 seconds the toast is gone", app.ctx.state.syncToast === null,
     JSON.stringify(app.ctx.state.syncToast));
  ok("after 2 seconds the app no longer renders the toast",
     app.ctx.document.getElementById("app").innerHTML.indexOf("sync-toast") === -1,
     ".sync-toast still rendered");
}

{
  const app = appWithPending("denied");
  const toast = app.ctx.state.syncToast;
  ok("a failed sync raises a SYNC FAILED toast", toast && toast.headline === "SYNC FAILED",
     toast ? toast.headline : "no toast");
  ok("the failed toast says why", toast && /denied/i.test(toast.detail),
     toast ? toast.detail : "no toast");
}

{
  const app = loadApp(Object.assign({}, CFG));
  ok("no toast on boot", app.ctx.state.syncToast == null, JSON.stringify(app.ctx.state.syncToast));
}

{
  /* the no-reply timeout is a failure too - it must raise the toast */
  const app = loadApp(Object.assign({}, CFG));
  app.ctx.logCompletion("MON", "workout");
  app.timers.forEach(t => { if (!t.cleared) t.fn(); });
  const toast = app.ctx.state.syncToast;
  ok("a no-reply timeout raises a SYNC FAILED toast", toast && toast.headline === "SYNC FAILED",
     toast ? toast.headline : "no toast");
}

/* ============================================================
   (j) the status line must be evidence-based, not config-guesswork
   Adam: "It sometimes says not connected while it clearly is cuz it works"
   ============================================================ */
{
  const app = loadApp({ "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" }) });
  ok("configured + never synced -> In sync", app.ctx.lockdStatusText() === "In sync", app.ctx.lockdStatusText());
  ok("configured + never synced -> IN SYNC headline", app.ctx.lockdSyncHeadline() === "IN SYNC", app.ctx.lockdSyncHeadline());
}

{
  const app = appWithPending("ok");
  ok("a successful sync is recorded", !!app.store["lockd-last-sync"], String(app.store["lockd-last-sync"]));
  const reloaded = loadApp(app.store);
  ok("after a reload the status still proves the connection",
     /^Connected - last sync 2026-10-19/.test(reloaded.ctx.lockdStatusText()),
     reloaded.ctx.lockdStatusText());
  ok("after a reload the headline is IN SYNC, not NOT SET UP",
     reloaded.ctx.lockdSyncHeadline() === "IN SYNC", reloaded.ctx.lockdSyncHeadline());
}

{
  /* config lost but a successful sync on record: never claim "not set up" */
  const app = loadApp({ "lockd-last-sync": JSON.stringify({ date: "2026-10-19", type: "workout", at: "2026-10-19T18:04:00.000Z" }) });
  ok("lost config + sync history -> CONFIG MISSING headline",
     app.ctx.lockdSyncHeadline() === "SYNC CONFIG MISSING", app.ctx.lockdSyncHeadline());
  ok("lost config + sync history -> status names the last sync",
     /^Config missing - last sync 2026-10-19/.test(app.ctx.lockdStatusText()), app.ctx.lockdStatusText());
  ok("lost config + sync history -> never says NOT SET UP",
     app.ctx.lockdSyncHeadline().indexOf("NOT SET UP") === -1, app.ctx.lockdSyncHeadline());
}

{
  const app = loadApp({});
  ok("no config + no history -> Not configured", app.ctx.lockdStatusText() === "Not configured", app.ctx.lockdStatusText());
  ok("no config + no history -> NOT SET UP headline",
     app.ctx.lockdSyncHeadline() === "LAPTOP SYNC NOT SET UP", app.ctx.lockdSyncHeadline());
}

/* ============================================================
   (k) saving must never blank a working config
   ============================================================ */
{
  const app = loadApp({ "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" }) });
  app.ctx.saveLaptopSyncPanel();   /* fields not on screen -> empty values */
  ok("saving with empty fields keeps the URL", app.ctx.laptopSync.url === "http://192.168.1.10:8787", app.ctx.laptopSync.url);
  ok("saving with empty fields keeps the token", app.ctx.laptopSync.token === "sekret", "token blanked");
  ok("saving with empty fields keeps the stored config",
     JSON.parse(app.store["laptop-sync"]).url === "http://192.168.1.10:8787", app.store["laptop-sync"]);
}

{
  const app = loadApp({});
  app.ctx.document.getElementById("lockdUrlInput").value = "192.168.1.10:8787";
  app.ctx.document.getElementById("lockdTokenInput").value = " sekret ";
  app.ctx.saveLaptopSyncPanel();
  ok("a scheme-less URL is saved as http://", app.ctx.laptopSync.url === "http://192.168.1.10:8787", app.ctx.laptopSync.url);
  ok("a saved scheme-less URL counts as configured", app.ctx.lockdConfigured() === true);
  ok("the token is trimmed on save", app.ctx.laptopSync.token === "sekret", app.ctx.laptopSync.token);
}

/* ============================================================
   (l) the setup form lives in DIAGNOSTICS, not on the main page
   ============================================================ */
{
  const app = loadApp({ "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "sekret" }) });
  const overview = app.ctx.renderOverview();
  ok("the main page has no laptop setup form", overview.indexOf("lockdUrlInput") === -1, "form still on the overview");
  ok("the main page has no LAPTOP SYNC panel", overview.indexOf("LAPTOP SYNC") === -1, "panel still on the overview");
  const stats = app.ctx.renderStats();
  ok("DIAGNOSTICS carries the laptop setup form", stats.indexOf("lockdUrlInput") > -1, "form missing from DIAGNOSTICS");
  ok("DIAGNOSTICS carries the auto-sync toggle", stats.indexOf("AUTO-SYNC AFTER WORKOUT") > -1);
  ok("DIAGNOSTICS carries the manual sync button", stats.indexOf("SYNC TO LAPTOP") > -1);
}

/* ============================================================
   (m) RELAY (Oct 26 2026)

   Windows Firewall blocks inbound to the daemon, so the laptop is not
   reachable on the LAN. The console therefore publishes ONE signed line to an
   ntfy topic, and the daemon polls that topic over outbound HTTPS:
       lockd|<date>|<type>|<hex HMAC-SHA256(token, "lockd|date|type")>
   The pinned signature below was computed independently with python hmac AND
   the PowerShell implementation, so all three agree.
   ============================================================ */
const RELAY_SIG = "2664d268f41a53478131735907bb51abab9174350582f9e36d0b6f93e1ef445e";
const settle = () => new Promise(r => setTimeout(r, 30));

async function runRelayTests() {
  /* m1 - config + signature */
  {
    const app = loadApp({ "laptop-sync": JSON.stringify({ token: "test-token-123", relayTopic: "lockd-topic" }) });
    ok("a topic plus a token counts as relay-configured", app.ctx.relayConfigured() === true);
    ok("no topic means no relay", loadApp({ "laptop-sync": JSON.stringify({ token: "t" }) }).ctx.relayConfigured() === false);
    const sig = await app.ctx.relaySignature("2026-10-26", "workout");
    ok("relay signature matches the pinned vector", sig === RELAY_SIG, sig);
    const body = await app.ctx.relayBody({ date: "2026-10-26", type: "workout" });
    ok("relay body is the signed line", body === "lockd|2026-10-26|workout|" + RELAY_SIG, body);
  }

  /* m2 - publish shape */
  {
    const app = loadApp({ "laptop-sync": JSON.stringify({ token: "test-token-123", relayTopic: "lockd-topic", relayServer: "ntfy.sh" }) }, null, { status: 200 });
    ok("a scheme-less relay server becomes https", app.ctx.relayServerUrl() === "https://ntfy.sh", app.ctx.relayServerUrl());
    const body = await app.ctx.relayBody({ date: "2026-10-26", type: "workout" });
    const res = await app.ctx.publishRelay({ date: "2026-10-26", type: "workout" });
    ok("publish reports success", res === true);
    ok("publish targets <server>/<topic>", app.fetchCalls.length === 1 && app.fetchCalls[0].url === "https://ntfy.sh/lockd-topic", JSON.stringify(app.fetchCalls.map(f => f.url)));
    ok("publish is a POST", app.fetchCalls[0].opts.method === "POST");
    ok("publish sends the signed line as the body", app.fetchCalls[0].opts.body === body);
  }

  /* m3 - the auto-sync path prefers the relay and never opens the popup */
  {
    const pending = { date: "2026-10-26", type: "workout", at: "2026-10-26T07:00:00.000Z" };
    const app = loadApp({ "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "test-token-123", relayTopic: "lockd-topic" }), "lockd-pending-sync": JSON.stringify(pending) }, null, { status: 200 });
    const opened = app.ctx.autoSyncToLaptop();
    ok("auto-sync with a relay starts", opened === true);
    ok("auto-sync with a relay opens no LAN popup", app.openCalls.length === 0, JSON.stringify(app.openCalls.map(o => o.url)));
    ok("auto-sync with a relay enters the syncing state", app.ctx.SYNC_STATE === "syncing");
    await settle();
    ok("a queued relay sync clears the pending", app.ctx.PENDING_SYNC === null, JSON.stringify(app.ctx.PENDING_SYNC));
    ok("a queued relay sync reports SENT, not unlocked", app.ctx.SYNC_STATE === "sent", app.ctx.SYNC_STATE);
    ok("the headline says SYNC SENT", app.ctx.lockdSyncHeadline() === "SYNC SENT", app.ctx.lockdSyncHeadline());
    ok("the last-sync record is written", !!app.store["lockd-last-sync"] && JSON.parse(app.store["lockd-last-sync"]).date === "2026-10-26");
    ok("the toast says SENT", !!app.ctx.state.syncToast && app.ctx.state.syncToast.headline === "SYNC SENT");
  }

  /* m4 - a failed publish keeps the pending so the tap can be retried */
  {
    const app = loadApp({ "laptop-sync": JSON.stringify({ token: "test-token-123", relayTopic: "lockd-topic" }), "lockd-pending-sync": JSON.stringify({ date: "2026-10-26", type: "workout" }) }, null, { mode: "throw", message: "network down" });
    app.ctx.autoSyncToLaptop();
    await settle();
    ok("a failed publish keeps the pending sync", app.ctx.PENDING_SYNC !== null && app.ctx.PENDING_SYNC.date === "2026-10-26", JSON.stringify(app.ctx.PENDING_SYNC));
    ok("a failed publish sets the error state", app.ctx.SYNC_STATE === "error", app.ctx.SYNC_STATE);
    ok("the failure names the relay", String(app.ctx.SYNC_STATUS).indexOf("Relay failed") === 0, app.ctx.SYNC_STATUS);
    ok("a failed publish writes no last-sync record", !app.store["lockd-last-sync"]);
  }

  /* m5 - a non-2xx answer is a failure, not a success */
  {
    const app = loadApp({ "laptop-sync": JSON.stringify({ token: "test-token-123", relayTopic: "lockd-topic" }), "lockd-pending-sync": JSON.stringify({ date: "2026-10-26", type: "workout" }) }, null, { status: 429 });
    app.ctx.autoSyncToLaptop();
    await settle();
    ok("HTTP 429 from the relay is an error", app.ctx.SYNC_STATE === "error", app.ctx.SYNC_STATE);
    ok("HTTP 429 keeps the pending sync", app.ctx.PENDING_SYNC !== null);
  }

  /* m6 - relay-only setup: no LAN URL needed at all */
  {
    const app = loadApp({ "laptop-sync": JSON.stringify({ token: "test-token-123", relayTopic: "lockd-topic" }) });
    ok("a relay-only setup is not LAN-configured", app.ctx.lockdConfigured() === false);
    ok("a relay-only setup has a headline", app.ctx.lockdSyncHeadline() === "RELAY READY", app.ctx.lockdSyncHeadline());
    ok("relay-only status mentions the relay", app.ctx.lockdStatusText() === "Relay set - ready", app.ctx.lockdStatusText());
    app.ctx.queueLockdSync("workout");
    ok("a relay-only setup still queues a sync", app.ctx.PENDING_SYNC !== null, JSON.stringify(app.ctx.PENDING_SYNC));
  }

  /* m7 - the setup form carries the relay fields and saves them */
  {
    const app = loadApp({});
    const stats = app.ctx.renderStats();
    ok("DIAGNOSTICS carries the relay topic field", stats.indexOf("lockdRelayTopicInput") > -1);
    ok("DIAGNOSTICS carries the relay server field", stats.indexOf("lockdRelayServerInput") > -1);
    app.ctx.document.getElementById("lockdTokenInput").value = "test-token-123";
    app.ctx.document.getElementById("lockdRelayTopicInput").value = " lockd-topic ";
    app.ctx.document.getElementById("lockdRelayServerInput").value = "ntfy.sh";
    app.ctx.saveLaptopSyncPanel();
    ok("the relay topic is trimmed and saved", app.ctx.laptopSync.relayTopic === "lockd-topic", app.ctx.laptopSync.relayTopic);
    ok("a scheme-less relay server is saved as https", app.ctx.laptopSync.relayServer === "https://ntfy.sh", app.ctx.laptopSync.relayServer);
    const again = loadApp({ "laptop-sync": app.store["laptop-sync"] });
    ok("the relay config survives a reload", again.ctx.laptopSync.relayTopic === "lockd-topic" && again.ctx.laptopSync.relayServer === "https://ntfy.sh");
  }
}

/* ============================================================
   (n) MAIN-PAGE SYNC PILL (Oct 26 2026)

   The relay hides the laptop, so the only thing the user must never be unsure
   about is WHICH control publishes. One pill on the main screen, one meaning:
   send today's completed session. No popup, no hidden state.
   ============================================================ */
async function runPillTests() {
  const relayCfg = JSON.stringify({ token: "test-token-123", relayTopic: "lockd-topic" });

  /* n1 - presence. The pill is ALWAYS there: an invisible control is the thing
     that made the first phone attempt impossible to diagnose. */
  {
    const on = loadApp({ "laptop-sync": relayCfg });
    ok("the main page has a sync pill when a relay is set", on.ctx.renderHeader().indexOf("mainSyncPill") > -1);
    ok("a configured pill offers SYNC", on.ctx.mainSyncLabel() === "NO WORKOUT YET", on.ctx.mainSyncLabel());

    const off = loadApp({ "laptop-sync": JSON.stringify({ url: "http://192.168.1.10:8787", token: "test-token-123" }) });
    ok("the main page still has a pill without a relay", off.ctx.renderHeader().indexOf("mainSyncPill") > -1);
    ok("an unconfigured pill says SET UP SYNC", off.ctx.mainSyncLabel() === "SET UP SYNC", off.ctx.mainSyncLabel());
    off.ctx.mainSyncTap();
    ok("an unconfigured pill tap opens DIAGNOSTICS", off.ctx.state.view === "stats", off.ctx.state.view);
    ok("an unconfigured pill tap publishes nothing", off.fetchCalls.length === 0);
  }

  /* n2 - what it sends */
  {
    const today = loadApp({ "laptop-sync": relayCfg }).ctx.localISO(new Date());
    const pendingApp = loadApp({ "laptop-sync": relayCfg, "lockd-pending-sync": JSON.stringify({ date: "2026-10-24", type: "boulder" }) });
    ok("the pill sends the pending session when there is one", JSON.stringify(pendingApp.ctx.mainSyncTarget()) === JSON.stringify({ date: "2026-10-24", type: "boulder" }), JSON.stringify(pendingApp.ctx.mainSyncTarget()));

    const loggedApp = loadApp({ "laptop-sync": relayCfg, "workout-history": JSON.stringify([{ date: today, day: 2, type: "workout", at: new Date().toISOString() }]) });
    ok("the pill sends today's logged workout", JSON.stringify(loggedApp.ctx.mainSyncTarget()) === JSON.stringify({ date: today, type: "workout" }), JSON.stringify(loggedApp.ctx.mainSyncTarget()));

    const emptyApp = loadApp({ "laptop-sync": relayCfg });
    ok("the pill has nothing to send on an untrained day", emptyApp.ctx.mainSyncTarget() === null);
    ok("the pill says there is nothing to send", emptyApp.ctx.mainSyncLabel() === "NO WORKOUT YET", emptyApp.ctx.mainSyncLabel());
  }

  /* n3 - the tap publishes today's session, in place, with no popup */
  {
    const today = loadApp({ "laptop-sync": relayCfg }).ctx.localISO(new Date());
    const app = loadApp({ "laptop-sync": relayCfg, "workout-history": JSON.stringify([{ date: today, day: 2, type: "workout", at: new Date().toISOString() }]) }, null, { status: 200 });
    const fired = app.ctx.mainSyncTap();
    ok("the pill tap starts a publish", fired === true);
    ok("the pill tap opens no LAN popup", app.openCalls.length === 0);
    ok("the pill says SYNCING while it waits", app.ctx.mainSyncLabel() === "SYNCING", app.ctx.mainSyncLabel());
    await settle();
    const body = await app.ctx.relayBody({ date: today, type: "workout" });
    ok("the pill published today's signed line", app.fetchCalls.length === 1 && app.fetchCalls[0].opts.body === body, app.fetchCalls.length ? app.fetchCalls[0].opts.body : "no fetch");
    ok("the pill says SENT afterwards", app.ctx.mainSyncLabel() === "SENT", app.ctx.mainSyncLabel());
  }

  /* n4 - an untrained tap publishes nothing and explains itself */
  {
    const app = loadApp({ "laptop-sync": relayCfg }, null, { status: 200 });
    const fired = app.ctx.mainSyncTap();
    ok("an untrained pill tap publishes nothing", app.fetchCalls.length === 0);
    ok("an untrained pill tap reports false", fired === false);
    ok("an untrained pill tap writes no last-sync", !app.store["lockd-last-sync"]);
    ok("an untrained pill tap explains itself", !!app.ctx.state.syncToast && app.ctx.state.syncToast.headline === "NOTHING TO SEND", JSON.stringify(app.ctx.state.syncToast));
  }

  /* n5 - a failed publish is visible on the pill itself */
  {
    const today = loadApp({ "laptop-sync": relayCfg }).ctx.localISO(new Date());
    const app = loadApp({ "laptop-sync": relayCfg, "workout-history": JSON.stringify([{ date: today, day: 2, type: "workout", at: new Date().toISOString() }]) }, null, { mode: "throw" });
    app.ctx.mainSyncTap();
    await settle();
    ok("a failed pill publish says RETRY SYNC", app.ctx.mainSyncLabel() === "RETRY SYNC", app.ctx.mainSyncLabel());
  }
}
/* ============================================================
   (o) QR SETUP (Oct 26 2026)

   Typing a 32-hex token on a phone keyboard is the likeliest remaining way
   this fails. The laptop instead renders a QR of `#sync=<topic>:<token>`; the
   phone camera opens the page with it and the app configures itself, then
   strips the fragment so the token does not sit in the address bar.
   ============================================================ */
async function runQrTests() {
  const payload = "#sync=lockd-topic:test-token-123";

  /* o1 - a scan configures the relay with zero typing */
  {
    const app = loadApp({}, null, null, payload);
    ok("a QR hash configures the relay topic", app.ctx.laptopSync.relayTopic === "lockd-topic", app.ctx.laptopSync.relayTopic);
    ok("a QR hash configures the token", app.ctx.laptopSync.token === "test-token-123");
    ok("a QR hash defaults the relay server", app.ctx.laptopSync.relayServer === "https://ntfy.sh", app.ctx.laptopSync.relayServer);
    ok("a QR hash makes the relay usable", app.ctx.relayConfigured() === true);
    ok("a QR hash is persisted", !!app.store["laptop-sync"] && JSON.parse(app.store["laptop-sync"]).relayTopic === "lockd-topic");
    ok("a QR hash leaves the pill ready", app.ctx.mainSyncLabel() === "NO WORKOUT YET", app.ctx.mainSyncLabel());
    ok("a QR hash is stripped from the address", app.replaceCalls.length === 1 && app.replaceCalls[0].indexOf("sync=") === -1, JSON.stringify(app.replaceCalls));
  }

  /* o2 - a configured server is not overwritten */
  {
    const app = loadApp({ "laptop-sync": JSON.stringify({ relayServer: "https://ntfy.example.com" }) }, null, null, payload);
    ok("a QR hash keeps an existing relay server", app.ctx.laptopSync.relayServer === "https://ntfy.example.com", app.ctx.laptopSync.relayServer);
  }

  /* o3 - rubbish in the hash changes nothing but is still stripped */
  {
    ["#sync=", "#sync=only-a-topic", "#sync=:token", "#day=3"].forEach(function (bad) {
      const app = loadApp({}, null, null, bad);
      ok("bad hash leaves the relay unconfigured: " + bad, app.ctx.relayConfigured() === false, JSON.stringify(app.ctx.laptopSync));
      ok("bad hash does not crash the pill: " + bad, app.ctx.mainSyncLabel() === "SET UP SYNC", app.ctx.mainSyncLabel());
    });
  }
}
runRelayTests().then(function () { return runPillTests(); }).then(function () { return runQrTests(); }).then(function () {
  console.log("\n" + pass + " passed, " + failures.length + " failed");
  if (failures.length) {
    console.log("failures:");
    failures.forEach(f => console.log(" - " + f));
    process.exit(1);
  }
}).catch(function (e) {
  console.log("FAIL - relay tests crashed: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
