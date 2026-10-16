"use strict";
/* ============================================================
   Training Console - plan integrity regression tests
   Run:  node tests/plan.test.js
   Exit code 0 = all green, 1 = failures.

   Guards the bug class that shipped in v7.12:
   a hand-edit to PLAN that left duplicate day keys, an orphaned
   property block and a missing comma, so the whole inline script
   failed to parse and the app rendered a black screen.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML_PATH = path.join(__dirname, "..", "index.html");
const SW_PATH = path.join(__dirname, "..", "sw.js");

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MODES = ["session", "boulder", "rest"];

let pass = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; console.log("ok   - " + name); }
  else { failures.push(name + (detail ? "  ::  " + detail : "")); console.log("FAIL - " + name + (detail ? "  ::  " + detail : "")); }
}

const html = fs.readFileSync(HTML_PATH, "utf8");

/* --- 1. script extraction ------------------------------------------ */
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok("exactly one inline script block", scripts.length === 1, "found " + scripts.length);
if (scripts.length !== 1) { console.log("\n" + pass + " passed, " + failures.length + " failed"); process.exit(1); }
const src = scripts[0];

/* --- 2. the whole thing must parse --------------------------------- */
let syntaxError = null;
try { new vm.Script(src, { filename: "index-inline.js" }); } catch (e) { syntaxError = e.message; }
ok("inline script parses (no SyntaxError)", syntaxError === null, syntaxError);

/* --- 3. PLAN source: each day declared exactly once ---------------- */
const planStart = src.indexOf("var DAY_ORDER");
const planEnd = src.indexOf("var WINDUP_SECONDS");
ok("PLAN block boundaries found", planStart > -1 && planEnd > planStart, "start=" + planStart + " end=" + planEnd);
const planSrc = src.slice(planStart, planEnd);

const keyRe = new RegExp("^\\s*(" + DAYS.join("|") + ")\\s*:", "gm");
const declared = [...planSrc.matchAll(keyRe)].map(m => m[1]);
let totalDeclared = 0, totalExpected = 0;
DAYS.forEach(function (d) {
  totalExpected++;
  const n = declared.filter(x => x === d).length;
  totalDeclared += n;
  ok("day key " + d + " declared exactly once", n === 1, "declared " + n + " time(s)");
});
ok("PLAN contains no extra day keys", declared.length === DAYS.length, "declared " + declared.length + " keys: " + declared.join(","));
ok("declared key total is 7", totalDeclared === 7, "n=" + totalDeclared);
ok("expected key total is 7", totalExpected === 7, "n=" + totalExpected);

/* --- 4. PLAN must be evaluable ------------------------------------- */
const sandbox = {};
let evalError = null, PLAN = null, DAY_ORDER = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(planSrc, sandbox, { filename: "plan.js" });
  PLAN = sandbox.PLAN;
  DAY_ORDER = sandbox.DAY_ORDER;
} catch (e) { evalError = e.message; }
ok("PLAN block evaluates in isolation", evalError === null, evalError);

if (PLAN) {
  /* --- 5. shape of every day ------------------------------------- */
  const keys = Object.keys(PLAN);
  ok("PLAN resolves to 7 days", keys.length === 7, "n=" + keys.length);
  ok("PLAN keys match DAY_ORDER", Array.isArray(DAY_ORDER) && DAY_ORDER.join(",") === DAYS.join(","), "DAY_ORDER=" + (DAY_ORDER || []).join(","));

  DAYS.forEach(function (d) {
    const day = PLAN[d];
    if (!day) { ok("PLAN." + d + " exists", false); return; }
    ok("PLAN." + d + " has a known mode", MODES.indexOf(day.mode) > -1, "mode=" + day.mode);
    ok("PLAN." + d + " has a title", typeof day.title === "string" && day.title.trim().length > 0);
    ok("PLAN." + d + " has a subtitle", typeof day.subtitle === "string" && day.subtitle.trim().length > 0);

    const hasSections = ["warmup", "main", "cooldown"].filter(k => Array.isArray(day[k]));
    if (day.mode === "session") {
      ok("PLAN." + d + " (session) has warmup/main/cooldown",
        hasSections.length === 3, "arrays present: " + hasSections.join(",") || "none");
      ["warmup", "main", "cooldown"].forEach(function (section) {
        const list = day[section];
        if (!Array.isArray(list)) return;
        ok("PLAN." + d + "." + section + " is not empty", list.length > 0, "n=" + list.length);
        list.forEach(function (item, i) {
          const tag = d + "." + section + "[" + i + "]";
          if (!item || typeof item !== "object") { ok(tag + " is an object", false); return; }
          ok(tag + " has a name", typeof item.name === "string" && item.name.trim().length > 0);
          ok(tag + " has type time|reps", item.type === "time" || item.type === "reps", "type=" + item.type);
          if (item.type === "time") ok(tag + " duration > 0", typeof item.duration === "number" && item.duration > 0, "duration=" + item.duration);
          if (item.type === "reps") ok(tag + " has a reps label", typeof item.label === "string" && item.label.trim().length > 0);
          if (item.sets !== undefined) ok(tag + " sets is 1-10", Number.isInteger(item.sets) && item.sets >= 1 && item.sets <= 10, "sets=" + item.sets);
          if (item.rest !== undefined) ok(tag + " rest >= 0", typeof item.rest === "number" && item.rest >= 0, "rest=" + item.rest);
        });
      });
    } else {
      ok("PLAN." + d + " (" + day.mode + ") has no session arrays", hasSections.length === 0, "arrays present: " + hasSections.join(","));
    }
  });

  /* --- 6. user-specified schedule invariants ---------------------- */
  ok("Tuesday is bouldering", PLAN.Tuesday && PLAN.Tuesday.mode === "boulder", "mode=" + (PLAN.Tuesday || {}).mode);
  ok("Sunday is rest", PLAN.Sunday && PLAN.Sunday.mode === "rest", "mode=" + (PLAN.Sunday || {}).mode);

  /* --- 6b. exercise vocabulary vs MUSCLE_TAGS --------------------- */
  /* Every exercise the app can log must have a muscle tag, otherwise its
     sets are silently counted as ZERO in the weekly muscle volume panel.
     Pure mobility/stretch items are exempt by design.
     Conversely, a tag for an exercise that is not in the plan is dead data,
     and the stats tab renders every tag key in its "EXERCISE MAPPING" panel,
     so the app ends up advertising exercises the plan does not contain. */
  const MOBILITY_EXEMPT = [
    "Shoulder CARs", "Wrist prep + mobility", "Wrist prep", "Scapular mobility",
    "Leg swings (front-back, side-side)", "Bodyweight squats", "Ankle mobility",
    "Shoulder stretch", "Wrist stretch", "Hip flexor stretch", "Quad stretch",
    "Hamstring stretch", "Lat stretch", "Chest doorway stretch", "Tricep stretch",
    "Child's pose"
  ];

  const tagStart = src.indexOf("var MUSCLE_TAGS");
  const tagEnd = src.indexOf("var MUSCLE_GROUPS");
  let MUSCLE_TAGS = null, tagErr = null;
  if (tagStart > -1 && tagEnd > tagStart) {
    try {
      const tagSandbox = {};
      vm.createContext(tagSandbox);
      vm.runInContext(src.slice(tagStart, tagEnd), tagSandbox, { filename: "muscle-tags.js" });
      MUSCLE_TAGS = tagSandbox.MUSCLE_TAGS;
    } catch (e) { tagErr = e.message; }
  }
  ok("MUSCLE_TAGS block found and evaluates", MUSCLE_TAGS !== null, tagErr || "boundaries start=" + tagStart + " end=" + tagEnd);

  if (MUSCLE_TAGS) {
    const planned = [];
    DAYS.forEach(function (d) {
      const day = PLAN && PLAN[d];
      if (!day || day.mode !== "session") return;
      ["warmup", "main", "cooldown"].forEach(function (sec) {
        (day[sec] || []).forEach(function (ex) { if (planned.indexOf(ex.name) < 0) planned.push(ex.name); });
      });
    });

    const untagged = planned.filter(function (n) {
      return !Object.prototype.hasOwnProperty.call(MUSCLE_TAGS, n) && MOBILITY_EXEMPT.indexOf(n) < 0;
    });
    ok("every loaded exercise has a MUSCLE_TAGS entry (or is mobility/stretch)",
      untagged.length === 0, untagged.length + " untagged: " + untagged.join(" | "));

    const orphans = Object.keys(MUSCLE_TAGS).filter(function (n) { return planned.indexOf(n) < 0; });
    ok("every MUSCLE_TAGS entry describes an exercise that exists in the plan",
      orphans.length === 0, orphans.length + " orphan(s): " + orphans.join(" | "));

    const emptyTags = Object.keys(MUSCLE_TAGS).filter(function (n) {
      const t = MUSCLE_TAGS[n];
      return !t || typeof t !== "object" || Object.keys(t).length === 0;
    });
    ok("no MUSCLE_TAGS entry is empty", emptyTags.length === 0, emptyTags.join(" | "));

    /* Guard: a misspelt muscle key renders as "undefined" in the stats panel
       (MUSCLE_LABELS[mg] / MUSCLE_COLORS[mg] both come back undefined). */
    const groupStart = src.indexOf("var MUSCLE_GROUPS");
    const groupEnd = src.indexOf("var MUSCLE_LABELS");
    let MUSCLE_GROUPS = null;
    if (groupStart > -1 && groupEnd > groupStart) {
      try {
        const gs = {};
        vm.createContext(gs);
        vm.runInContext(src.slice(groupStart, groupEnd), gs, { filename: "muscle-groups.js" });
        MUSCLE_GROUPS = gs.MUSCLE_GROUPS;
      } catch (e) { MUSCLE_GROUPS = null; }
    }
    ok("MUSCLE_GROUPS block found and evaluates", Array.isArray(MUSCLE_GROUPS), "not evaluated");
    if (Array.isArray(MUSCLE_GROUPS)) {
      const badKeys = [];
      Object.keys(MUSCLE_TAGS).forEach(function (n) {
        Object.keys(MUSCLE_TAGS[n] || {}).forEach(function (mg) {
          if (MUSCLE_GROUPS.indexOf(mg) < 0) badKeys.push(n + " -> " + mg);
        });
      });
      ok("every muscle key in MUSCLE_TAGS is a known MUSCLE_GROUPS entry", badKeys.length === 0, badKeys.join(" | "));
    }
  }

  /* --- 6c. programming invariants (added Oct 14 2026) ---------------- */
  /* No exercise may appear twice in the same day: the redesign left Thursday
     running scapular pull-ups in the warm-up AND in the main block. */
  const repeats = [];
  DAYS.forEach(function (d) {
    const day = PLAN[d];
    if (!day || day.mode !== "session") return;
    const seen = {};
    ["warmup", "main", "cooldown"].forEach(function (sec) {
      (day[sec] || []).forEach(function (ex) {
        seen[ex.name] = (seen[ex.name] || 0) + 1;
        if (seen[ex.name] === 2) repeats.push(d + ": " + ex.name);
      });
    });
  });
  ok("no exercise is repeated within a single day", repeats.length === 0, repeats.join(" | "));

  /* The goal is a front lever, whose prerequisite is real pulling strength.
     The week must contain BOTH a vertical pull and a horizontal pull, and
     pulling must appear on more than one day: one weekly exposure maintains,
     it does not build. */
  const VERTICAL_PULLS = ["Strict pull-ups", "Pull-ups", "Assisted pull-ups", "Band pull-up negatives"];
  const HORIZONTAL_PULLS = ["Ring rows", "Ring rows (feet elevated)", "Australian pulls", "Australian pulls (elevated)"];
  function mainNames(dayKey) {
    const day = PLAN[dayKey];
    return day && Array.isArray(day.main) ? day.main.map(function (e) { return e.name; }) : [];
  }
  function daysWithMain(list) {
    return DAYS.filter(function (d) {
      return mainNames(d).some(function (n) { return list.indexOf(n) > -1; });
    });
  }
  const verticalDays = daysWithMain(VERTICAL_PULLS);
  const horizontalDays = daysWithMain(HORIZONTAL_PULLS);
  const pullingDays = DAYS.filter(function (d) {
    return mainNames(d).some(function (n) {
      return VERTICAL_PULLS.indexOf(n) > -1 || HORIZONTAL_PULLS.indexOf(n) > -1;
    });
  });
  ok("week contains a vertical pull as a main item", verticalDays.length > 0, "found on: " + (verticalDays.join(",") || "nowhere"));
  ok("week contains a horizontal pull as a main item", horizontalDays.length > 0, "found on: " + (horizontalDays.join(",") || "nowhere"));
  ok("pulling work appears on at least 2 distinct days", pullingDays.length >= 2, "n=" + pullingDays.length + " (" + (pullingDays.join(",") || "none") + ")");

  /* One value per movement: a movement prescribed as a main item on several
     days carries the same per-set dose. Set counts may still differ by day. */
  const doseMap = {};
  DAYS.forEach(function (d) {
    const day = PLAN[d];
    if (!day || day.mode !== "session") return;
    (day.main || []).forEach(function (ex) {
      const dose = ex.type === "time" ? "time:" + ex.duration + "s" : "reps:" + ex.label;
      if (!doseMap[ex.name]) doseMap[ex.name] = {};
      if (!doseMap[ex.name][dose]) doseMap[ex.name][dose] = [];
      doseMap[ex.name][dose].push(d);
    });
  });
  const drifted = Object.keys(doseMap).filter(function (n) { return Object.keys(doseMap[n]).length > 1; }).map(function (n) {
    return n + " -> " + Object.keys(doseMap[n]).map(function (k) { return k + " on " + doseMap[n][k].join("+"); }).join(" vs ");
  });
  ok("a movement prescribed as a main item carries one dose across the week", drifted.length === 0, drifted.join(" | "));
}

/* --- 6d. calibration battery logger (added Oct 15 2026) ------------ */
/* The battery is a one-shot data-collection flow, not a workout: it must
   not touch PLAN, day completion, PRs or set logs. These assertions guard
   the battery definition (order, input types, rest rules), the flow
   functions, the two storage keys and the copy-to-clipboard format that
   Nexus reads to build PLAN v7.15. */
{
  const batMatch = src.match(/var BATTERY = (\[[\s\S]*?\n\]);/);
  ok("BATTERY block found", !!batMatch, "var BATTERY [...] not matched");
  let BATTERY = null;
  if (batMatch) {
    try {
      const bs = {};
      vm.createContext(bs);
      vm.runInContext("var BATTERY = " + batMatch[1], bs, { filename: "battery.js" });
      BATTERY = bs.BATTERY;
    } catch (e) { ok("BATTERY block evaluates", false, e.message); }
  }
  ok("BATTERY evaluates to an array", Array.isArray(BATTERY), typeof BATTERY);

  if (Array.isArray(BATTERY)) {
    ok("BATTERY has exactly 9 tests", BATTERY.length === 9, "n=" + BATTERY.length);
    ok("BATTERY ids are unique", new Set(BATTERY.map(t => t.id)).size === BATTERY.length,
      BATTERY.map(t => t.id).join(","));
    BATTERY.forEach(function (t, i) {
      const tag = "BATTERY[" + i + "] (" + t.id + ")";
      ok(tag + " n == position", t.n === i + 1, "n=" + t.n);
      ok(tag + " has a non-empty name", typeof t.name === "string" && t.name.trim().length > 0);
      ok(tag + " input is hold|reps|perleg", ["hold", "reps", "perleg"].indexOf(t.input) > -1, "input=" + t.input);
      ok(tag + " has non-empty cues", typeof t.cues === "string" && t.cues.trim().length > 0);
      ok(tag + " has >= 1 non-empty variant", Array.isArray(t.variants) && t.variants.length >= 1 &&
        t.variants.every(v => typeof v === "string" && v.trim().length > 0), JSON.stringify(t.variants));
      ok(tag + " restAfter is an integer >= 0", Number.isInteger(t.restAfter) && t.restAfter >= 0, "restAfter=" + t.restAfter);
    });
    const byId = {};
    BATTERY.forEach(t => { byId[t.id] = t; });
    ok("test 1 (handstand) allows 2 attempts", byId.handstand && byId.handstand.attempts === 2, "attempts=" + (byId.handstand || {}).attempts);
    ["tucklever", "pike", "diamond", "pullups", "scapular", "hollow", "pistol", "bulgarian"].forEach(function (id) {
      ok("test " + id + " is single-attempt", byId[id] && byId[id].attempts === 1, "attempts=" + (byId[id] || {}).attempts);
    });
    ok("4 min rest before test 5", byId.diamond && byId.diamond.restAfter === 240, "restAfter=" + (byId.diamond || {}).restAfter);
    ok("no rest between pistol and Bulgarian (straight after)", byId.pistol && byId.pistol.restAfter === 0 && byId.bulgarian && byId.bulgarian.restAfter === 0);
    ok("BATTERY order matches the field sheet", BATTERY.map(t => t.id).join(",") === "handstand,tucklever,pike,diamond,pullups,scapular,hollow,pistol,bulgarian");
  }

  /* flow functions */
  ["startCalibration", "exitCalibration", "calibStartClock", "calibStopClock",
   "calibSaveResult", "calibSkipRest", "calibSaveBattery",
   "formatCalibrationResults", "copyCalibrationResults"].forEach(function (fn) {
    ok("function " + fn + " defined", new RegExp("function\\s+" + fn + "\\s*\\(").test(src), "not found");
  });

  /* storage keys */
  ok('references "calibration-session"', src.indexOf('"calibration-session"') > -1);
  ok('references "calibration-log"', src.indexOf('"calibration-log"') > -1);

  /* overview entry button (the visible way in) */
  ok("overview renders the CALIBRATE entry button", html.indexOf("CALIBRATE (9 TESTS)") > -1);

  /* export rides the battery log along */
  ok("export payload includes calibrationLog", /calibrationLog:\s*state\.calibrationLog/.test(src));

  /* copy format: evaluate the pure formatter against a fixture */
  const fmtMatch = src.match(/function formatCalibrationResults([\s\S]*?)\n\}/);
  ok("formatCalibrationResults extractable", !!fmtMatch, "not found");
  if (fmtMatch) {
    try {
      const fsb = {};
      vm.createContext(fsb);
      vm.runInContext("var BATTERY = " + batMatch[1] + ";function formatCalibrationResults" + fmtMatch[1] + "\n}", fsb, { filename: "fmt.js" });
      const fixture = {
        date: "2026-10-16",
        results: {
          handstand: { attempts: [12, 22], variant: "chest-to-wall" },
          tucklever: { value: 9, variant: "tuck" },
          pike: { value: 11, variant: "feet-elevated" },
          diamond: { value: 18, variant: "full" },
          pullups: { value: 7, variant: "strict" },
          scapular: { value: 14, variant: "full hang" },
          hollow: { value: 41, variant: "arms overhead" },
          pistol: { left: 4, right: 3, variant: "full" },
          bulgarian: { left: 12, right: 11, variant: "feet elevated" }
        },
        effort: 8,
        notes: "left shoulder tight"
      };
      const out = fsb.formatCalibrationResults(fixture.results, fixture.effort, fixture.notes, fixture.date);
      ok("copy block starts with CALIBRATION + date", out.split("\n")[0] === "CALIBRATION 2026-10-16", out.split("\n")[0]);
      for (let n = 1; n <= 9; n++) {
        ok("copy block numbers test " + n, new RegExp("^" + n + " ", "m").test(out), "missing line " + n);
      }
      ok("copy block shows best-of-2 for test 1", out.indexOf("22s") > -1 && out.indexOf("12") > -1);
      ok("copy block shows L/R for pistol", /8 Pistol squat: L 4 \/ R 3 \(full\)/.test(out));
      ok("copy block carries effort + notes", out.indexOf("effort: 8") > -1 && out.indexOf("notes: left shoulder tight") > -1);
      ok("copy block omits empty optional lines", !/effort:\s*$/m.test(formatFixtureEmpty(fsb)) , "empty effort line present");
    } catch (e) { ok("formatCalibrationResults evaluates", false, e.message); }
  }
  function formatFixtureEmpty(fsb) {
    const f = { handstand: { attempts: [5, 6], variant: "chest-to-wall" } };
    try { return fsb.formatCalibrationResults(f, "", "", "2026-10-16"); } catch (e) { return "effort:"; }
  }
}

/* --- 6e. calibration mapping v7.15 (Oct 16 2026) -------------------- */
/* Adam ran the 9-test battery on Oct 15 2026. Measured maxima (spec
   section 5 of the calibration design):
     T1 handstand 11s chest-to-wall -> REGRESSION TRIGGER (11 < 15)
     T2 tuck lever 12s (form caveat) | T3 pike 7 | T4 diamond 8
     T5 strict pull-ups 5 | T6 scapular 9 (full hang) | T7 hollow 21s
     T8 pistol L9/R9 assisted | T9 Bulgarian L12/R12 feet elevated.
   These assertions PIN the mapped values so the plan cannot drift back
   to guesses. Update them ONLY alongside a retest (4-6 week cadence). */
if (PLAN) {
  const calItems = [];
  DAYS.forEach(function (d) {
    const day = PLAN[d];
    if (!day || day.mode !== "session") return;
    ["warmup", "main", "cooldown"].forEach(function (sec) {
      (day[sec] || []).forEach(function (ex) { calItems.push({ day: d, sec: sec, ex: ex }); });
    });
  });
  const calFind = n => calItems.filter(i => i.ex.name === n);
  const calDose = ex => ex.type === "time" ? ex.duration + "s" : ex.label;

  /* Regression trigger: handstand 11s < 15s, so the hard movement leaves
     the plan entirely - the plan gets the regression movement, not a
     smaller number of the hard one. */
  ok("Wall handstand hold removed (regression trigger: 11s < 15s)", calFind("Wall handstand hold").length === 0);
  const planks = calFind("Wall plank holds");
  ok("Wall plank holds present as Monday main", planks.length === 1 && planks[0].day === "Monday" && planks[0].sec === "main",
    planks.length + " found");
  ok("wall plank dose is 4 x 20s",
    planks.length === 1 && planks[0].ex.sets === 4 && calDose(planks[0].ex) === "20s",
    planks.length === 1 ? planks[0].ex.sets + " x " + calDose(planks[0].ex) : "absent");

  /* Rep movements: 70-80% of measured max, top of range capped at max-2.
     Scapular pull-ups sits in a warm-up, so it takes the field-sheet's
     "5 easy" protocol dose instead (the old 10 reps exceeded his 9 max). */
  const CAL_REPS = [
    ["Pike push-ups (elevated feet)", "4-5 reps"],
    ["Diamond push-ups (full)", "5-6 reps"],
    ["Strict pull-ups", "3 reps"],
    ["Pistol squat (assisted)", "6-7 / leg"],
    ["Bulgarian split squats (feet elevated)", "8-9 / leg"],
    ["Scapular pull-ups", "5 reps"]
  ];
  CAL_REPS.forEach(function (row) {
    const hits = calFind(row[0]);
    ok(row[0] + ' prescribed "' + row[1] + '" everywhere it appears',
      hits.length > 0 && hits.every(h => h.ex.type === "reps" && h.ex.label === row[1]),
      hits.length ? "got " + hits.map(h => calDose(h.ex)).join(",") : "not in plan");
  });

  /* Isometric holds: single timer value per set. Lever 50-60% of 12s ->
     6s (bottom of range, form caveat). Hollow 60-70% of 21s -> 14s (top
     of range: the under-30s core is the documented bottleneck). */
  const levers = calFind("Tuck front lever holds");
  ok("tuck lever dose is 6s (50-60% of 12s, bottom of range - form caveat)",
    levers.length === 2 && levers.every(h => h.ex.type === "time" && h.ex.duration === 6),
    levers.length ? "got " + levers.map(h => calDose(h.ex)).join(",") : "not in plan");
  const hollows = calFind("Hollow body hold (arms at sides)");
  ok("hollow body hold carries measured variant + dose 14s (60-70% of 21s)",
    hollows.length === 4 && hollows.every(h => h.ex.type === "time" && h.ex.duration === 14),
    hollows.length ? "n=" + hollows.length + " got " + hollows.map(h => calDose(h.ex)).join(",") : "not in plan");

  /* Warm-up hollow holds must sit strictly below the main dose: the old
     20s "light" was 95% of a 21s max - not light, pre-fatigue. */
  const warmHollow = calItems.filter(i => i.sec === "warmup" && i.ex.name.indexOf("Hollow hold") === 0);
  ok("warm-up hollow holds scaled below the main dose (4 items, all < 14s)",
    warmHollow.length === 4 && warmHollow.every(i => i.ex.type === "time" && i.ex.duration < 14),
    "n=" + warmHollow.length + " got " + warmHollow.map(i => i.ex.name + "=" + calDose(i.ex)).join(", "));
}

/* --- 7. version + assets ------------------------------------------- */
const verMatch = html.match(/var APP_VERSION = "(v[0-9]+(?:\.[0-9]+)*)"/);
ok("APP_VERSION present and well formed", !!verMatch, "none found");
const sw = fs.readFileSync(SW_PATH, "utf8");
ok("sw.js has a CACHE_NAME", /const CACHE_NAME = "[^"]+"/.test(sw));
ok("index.html registers sw.js", /serviceWorker/.test(html) && /sw\.js/.test(html));

/* --- 8. ASCII-only standing rule (BOM allowed on line 1) ----------- */
const offenders = [];
for (let i = 0; i < html.length; i++) {
  const c = html.charCodeAt(i);
  if (c > 126 && c !== 0xfeff) offenders.push({ line: html.slice(0, i).split("\n").length, code: "U+" + c.toString(16).toUpperCase() });
}
ok("index.html is ASCII-only (non-BOM)", offenders.length === 0, offenders.length + " offender(s): " + JSON.stringify(offenders.slice(0, 8)));

/* --- summary ------------------------------------------------------- */
console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) { console.log("failures:"); failures.forEach(f => console.log(" - " + f)); process.exit(1); }
