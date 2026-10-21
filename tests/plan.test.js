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
const MUSCLE_GROUPS_LIST = ["chest", "shoulders", "triceps", "biceps", "lats", "rear_delts", "core", "quads", "hamstrings", "glutes", "forearms", "traps"];

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
    ok("BATTERY has exactly 10 tests", BATTERY.length === 10, "n=" + BATTERY.length);
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
    ["tucklever", "pike", "diamond", "pullups", "ringrows", "scapular", "hollow", "pistol", "bulgarian"].forEach(function (id) {
      ok("test " + id + " is single-attempt", byId[id] && byId[id].attempts === 1, "attempts=" + (byId[id] || {}).attempts);
    });
    ok("4 min rest before test 5", byId.diamond && byId.diamond.restAfter === 240, "restAfter=" + (byId.diamond || {}).restAfter);
    ok("no rest between pistol and Bulgarian (straight after)", byId.pistol && byId.pistol.restAfter === 0 && byId.bulgarian && byId.bulgarian.restAfter === 0);
    ok("BATTERY order matches the field sheet", BATTERY.map(t => t.id).join(",") === "handstand,tucklever,pike,diamond,pullups,ringrows,scapular,hollow,pistol,bulgarian");
    ok("ring rows sits immediately after pull-ups", BATTERY[5] && BATTERY[5].id === "ringrows", "index 5 = " + (BATTERY[5] || {}).id);

    /* v8.1: every test declares how it maps (spec 5.5) */
    const RULE_NAMES = ["handstand", "skill_hold", "core_hold", "strength_reps", "fixed"];
    BATTERY.forEach(function (t, i) {
      const tag = "BATTERY[" + i + "] (" + t.id + ")";
      ok(tag + " declares a known rule", RULE_NAMES.indexOf(t.rule) > -1, "rule=" + t.rule);
      ok(tag + " declares a non-empty variantNames map",
        t.variantNames && typeof t.variantNames === "object" && Object.keys(t.variantNames).length > 0);
      if (t.variantNames) {
        const missing = t.variants.filter(v => !t.variantNames[v]);
        ok(tag + " variantNames is total over variants", missing.length === 0, "missing: " + missing.join(","));
        const bad = Object.keys(t.variantNames).filter(k => t.variants.indexOf(k) < 0);
        ok(tag + " variantNames has no rung the test does not offer", bad.length === 0, "extra: " + bad.join(","));
      }
      if (t.rule === "strength_reps") {
        ok(tag + " declares unit reps|/ leg", t.unit === "reps" || t.unit === "/ leg", "unit=" + t.unit);
        ok(tag + " fixedLabel is null", t.fixedLabel === null, "fixedLabel=" + t.fixedLabel);
      }
      if (t.rule === "fixed") {
        ok(tag + " declares a non-empty fixedLabel", typeof t.fixedLabel === "string" && t.fixedLabel.trim().length > 0, "fixedLabel=" + t.fixedLabel);
      }
    });
    /* every variantNames value must be unique across all tests: the reverse
       index in the app depends on it (spec 9.2) */
    const allNames = [];
    BATTERY.forEach(t => { if (t.variantNames) Object.keys(t.variantNames).forEach(k => allNames.push(t.variantNames[k])); });
    ok("variantNames values are unique across all tests",
      new Set(allNames).size === allNames.length,
      allNames.filter((n, i) => allNames.indexOf(n) !== i).join(","));
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
  ok("overview renders the CALIBRATE entry button", html.indexOf("CALIBRATE (10 TESTS)") > -1);

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
          ringrows: { value: 14, variant: "feet elevated" },
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
      for (let n = 1; n <= 10; n++) {
        ok("copy block numbers test " + n, new RegExp("^" + n + " ", "m").test(out), "missing line " + n);
      }
      ok("copy block shows best-of-2 for test 1", out.indexOf("22s") > -1 && out.indexOf("12") > -1);
      ok("copy block shows L/R for pistol", /9 Pistol squat: L 4 \/ R 3 \(full\)/.test(out));
      ok("copy block carries effort + notes", out.indexOf("effort: 8") > -1 && out.indexOf("notes: left shoulder tight") > -1);
      ok("copy block omits empty optional lines", !/effort:\s*$/m.test(formatFixtureEmpty(fsb)) , "empty effort line present");
    } catch (e) { ok("formatCalibrationResults evaluates", false, e.message); }
  }
  function formatFixtureEmpty(fsb) {
    const f = { handstand: { attempts: [5, 6], variant: "chest-to-wall" } };
    try { return fsb.formatCalibrationResults(f, "", "", "2026-10-16"); } catch (e) { return "effort:"; }
  }
}

/* --- 6e. calibration mapping v8.0 (Oct 17 2026) -------------------- */
/* Adam ran the 9-test battery on Oct 15 2026. Measured maxima (spec
   section 5 of the calibration design):
     T1 handstand 11s chest-to-wall | T2 tuck lever 12s (form caveat)
     T3 pike 7 | T4 diamond 8 | T5 strict pull-ups 5
     T6 scapular 9 (full hang) | T7 hollow 21s
     T8 pistol L9/R9 assisted | T9 Bulgarian L12/R12 feet elevated.
   v8.0 REDESIGN (spec 2026-10-17-training-plan-redesign-design.md):
   the v7.15 handstand regression is OVERRIDDEN. Chest-to-wall holds
   return at 8s (73% of an 11s max = genuine headroom, not a failed set)
   because the research names chest-to-wall work as the fix for the lean,
   not a regression away from it. Wall plank holds are demoted to a
   warm-up ramp. The pistol dose is held at 3-5/leg as a deliberate
   leverage-progression deviation (progress by lowering the box, not by
   adding reps). These assertions PIN the mapped values so the plan
   cannot drift back to guesses. Update them ONLY alongside a retest
   (4-6 week cadence). */
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

  /* The old regression movement must stay gone. */
  ok("Wall handstand hold removed (superseded by the chest-to-wall block)", calFind("Wall handstand hold").length === 0);

  /* v8.0: the handstand returns as a MAIN item at 8s (73% of the 11s max). */
  const hs = calFind("Chest-to-wall handstand holds");
  ok("chest-to-wall handstand holds present as a main item",
    hs.length > 0 && hs.every(h => h.sec === "main"), hs.length + " found");
  ok("handstand dose is 8s everywhere (73% of the measured 11s max)",
    hs.length > 0 && hs.every(h => h.ex.type === "time" && h.ex.duration === 8),
    hs.map(h => calDose(h.ex)).join(","));
  const hsDays = DAYS.filter(d => (PLAN[d].main || []).some(e => e.name === "Chest-to-wall handstand holds"));
  ok("handstand skill work is a main item on at least 5 days", hsDays.length >= 5,
    "n=" + hsDays.length + " (" + hsDays.join(",") + ")");
  const hsNotFirst = DAYS.filter(function (d) {
    const m = (PLAN[d].main || []).map(e => e.name);
    return m.indexOf("Chest-to-wall handstand holds") > 0;
  });
  ok("handstand block is the FIRST main item on every day it appears (skill before strength)",
    hsNotFirst.length === 0, hsNotFirst.join(","));

  /* v8.0: wall plank holds demoted from Monday main to a warm-up ramp. */
  const planks = calFind("Wall plank holds");
  ok("wall plank holds demoted to a warm-up ramp on 2 days",
    planks.length === 2 && planks.every(p => p.sec === "warmup" && p.ex.sets === 2 && calDose(p.ex) === "15s"),
    planks.length ? planks.map(p => p.day + "." + p.sec + " " + p.ex.sets + "x" + calDose(p.ex)).join(", ") : "absent");

  /* Rep movements: 70-80% of measured max, top of range capped at max-2.
     Scapular pull-ups sits in a warm-up, so it takes the field-sheet's
     "5 easy" protocol dose instead (the old 10 reps exceeded his 9 max).
     Pistol squat is the documented v8.0 leverage-progression deviation. */
  const CAL_REPS = [
    ["Pike push-ups (elevated feet)", "4-5 reps"],
    ["Diamond push-ups (full)", "5-6 reps"],
    ["Strict pull-ups", "3 reps"],
    ["Pistol squat (assisted)", "3-5 / leg"],
    ["Bulgarian split squats (feet elevated)", "8-9 / leg"],
    ["Scapular pull-ups", "5 reps"]
  ];
  CAL_REPS.forEach(function (row) {
    const hits = calFind(row[0]);
    ok(row[0] + ' prescribed "' + row[1] + '" everywhere it appears',
      hits.length > 0 && hits.every(h => h.ex.type === "reps" && h.ex.label === row[1]),
      hits.length ? "got " + hits.map(h => calDose(h.ex)).join(",") : "not in plan");
  });

  /* Pistol is a stated goal, so it gets 2 exposures: Thursday primary,
     Monday a short secondary. One session a week maintains, not builds. */
  const pistols = calFind("Pistol squat (assisted)");
  ok("pistol squat appears on 2 days (Thursday primary + Monday secondary)", pistols.length === 2,
    pistols.map(p => p.day + " x" + p.ex.sets).join(", "));

  /* Pike is capped at 2 days: overhead pressing competes with handstand
     skill frequency, and the handstand is the priority. */
  const pikeDays = DAYS.filter(d => (PLAN[d].main || []).some(e => e.name === "Pike push-ups (elevated feet)"));
  ok("pike push-ups appear on exactly 2 days (documented frequency deviation)", pikeDays.length === 2,
    "n=" + pikeDays.length + " (" + pikeDays.join(",") + ")");

  /* Isometric holds: single timer value per set.
     v8.3 (Oct 21 2026): the tuck lever becomes BAND-ASSISTED at 12s - the
     unassisted 12s max was flagged for poor form, so the band buys a clean
     hips-level hold instead of a longer bad one - and the hollow becomes a
     ONE-LEG hold at 20s. One leg extended is a bridge variation (easier
     than the full hollow), which is why the time goes UP here. */
  const levers = calFind("Band-assisted tuck front lever holds");
  ok("band-assisted tuck lever dose is 12s on both pulling days",
    levers.length === 2 && levers.every(h => h.ex.type === "time" && h.ex.duration === 12),
    levers.length ? "got " + levers.map(h => calDose(h.ex)).join(",") : "not in plan");
  const hollows = calFind("One-leg hollow body hold");
  ok("one-leg hollow body hold dose is 20s on all 4 core days",
    hollows.length === 4 && hollows.every(h => h.ex.type === "time" && h.ex.duration === 20),
    hollows.length ? "n=" + hollows.length + " got " + hollows.map(h => calDose(h.ex)).join(",") : "not in plan");

  /* Warm-up hollow holds must sit strictly below the main dose: the old
     20s "light" was 95% of a 21s max - not light, pre-fatigue. v8.0 runs
     two of them (Friday and Saturday); Monday and Thursday gave theirs up
     to the handstand block and the ankle work. */
  const warmHollow = calItems.filter(i => i.sec === "warmup" && i.ex.name.indexOf("Hollow hold") === 0);
  ok("warm-up hollow holds scaled below the main dose (2 items, all < 20s)",
    warmHollow.length === 2 && warmHollow.every(i => i.ex.type === "time" && i.ex.duration < 20),
    "n=" + warmHollow.length + " got " + warmHollow.map(i => i.ex.name + "=" + calDose(i.ex)).join(", "));

  /* --- 6f. equipment legality (v8.0, Oct 17 2026) ------------------- */
  /* Adam has NO bar, rings, bands or dip bars on Monday and Thursday -
     box/bench/chair, floor, wall and parallettes only. The first draft of
     the v8.0 redesign put the entire pull session on Thursday: a dead
     slot. This is the assertion that catches it, and it is the reason
     the week is shaped the way it is. */
  const BAR_RING = ["Scapular pull-ups", "Dead hang (light)", "Strict pull-ups", "Tuck front lever holds",
    "Band-assisted tuck front lever holds", "One-leg tuck front lever holds",
    "Ring rows", "Pull-ups", "Assisted pull-ups", "Band pull-up negatives",
    "Ring rows (feet elevated)", "Australian pulls", "Australian pulls (elevated)"];
  const NO_BAR_DAYS = ["Monday", "Thursday"];
  const FULL_KIT_DAYS = ["Wednesday", "Friday", "Saturday"];
  const illegal = [];
  NO_BAR_DAYS.forEach(function (d) {
    ["warmup", "main", "cooldown"].forEach(function (sec) {
      ((PLAN[d] || {})[sec] || []).forEach(function (ex) {
        if (BAR_RING.indexOf(ex.name) > -1) illegal.push(d + "." + sec + ": " + ex.name);
      });
    });
  });
  ok("no bar/ring movement on Monday or Thursday (no bar, rings, bands or dip bars)",
    illegal.length === 0, illegal.join(" | "));
  const barDays = DAYS.filter(function (d) {
    return ["warmup", "main", "cooldown"].some(function (sec) {
      return ((PLAN[d] || {})[sec] || []).some(function (ex) { return BAR_RING.indexOf(ex.name) > -1; });
    });
  });
  ok("bar/ring work lands only on full-kit days (Wed/Fri/Sat)",
    barDays.length > 0 && barDays.every(d => FULL_KIT_DAYS.indexOf(d) > -1), barDays.join(","));
}

/* --- 6g. cues, rest-screen description, retest reminder (v8.0) ------ */
if (PLAN) {
  const noCue = [];
  DAYS.forEach(function (d) {
    const day = PLAN[d];
    if (!day || day.mode !== "session") return;
    ["warmup", "main", "cooldown"].forEach(function (sec) {
      (day[sec] || []).forEach(function (ex, i) {
        if (typeof ex.cue !== "string" || !ex.cue.trim()) noCue.push(d + "." + sec + "[" + i + "] " + ex.name);
      });
    });
  });
  ok("every exercise carries a non-empty cue", noCue.length === 0, noCue.join(" | "));

  /* All three queue builders must carry the cue: the session view and the
     rest-screen description both read it off the queue step. Each is
     evaluated against the same fixture rather than grepped. (Worth the
     coverage: buildQueueNoWarmup briefly lost its `var plan` line during
     the v8.0 edit and would not have been caught otherwise.) */
  const BQ_FIXTURE =
    "var PLAN = { Monday: { mode:'session', warmup:[{name:'W', cue:'warm cue', type:'time', duration:10}], main:[{name:'X', cue:'do the thing', type:'time', duration:8, sets:2, rest:90}], cooldown:[] } };" +
    "var state = { cooldownSkip:false, overrides:{} };" +
    "function getEffective(d, s, i){ return PLAN[d][s.toLowerCase()][i]; }";
  const BQ_FNS = [
    ["buildQueue", "function buildQueue\\(day\\)", "var q = buildQueue('Monday');", 3],
    ["buildQueueNoWarmup", "function buildQueueNoWarmup\\(day\\)", "var q = buildQueueNoWarmup('Monday');", 2],
    ["buildQueueCustom", "function buildQueueCustom\\(day, sets\\)", "var q = buildQueueCustom('Monday', 2);", 2]
  ];
  BQ_FNS.forEach(function (row) {
    const name = row[0];
    const m = src.match(new RegExp(row[1] + "[\\s\\S]*?\\n\\}"));
    ok(name + " extractable", !!m, "not found");
    if (!m) return;
    try {
      const bs = {};
      vm.createContext(bs);
      vm.runInContext(BQ_FIXTURE + m[0] + ";" + row[2], bs, { filename: name + ".js" });
      const steps = bs.q;
      ok(name + " returns the expected steps",
        Array.isArray(steps) && steps.length === row[3], "n=" + (steps || []).length);
      ok(name + " propagates cue onto every queue step",
        Array.isArray(steps) && steps.length === row[3] && steps.every(s => typeof s.cue === "string" && s.cue.length > 0),
        JSON.stringify(steps));
    } catch (e) { ok(name + " evaluates with a fixture", false, e.message); }
  });
}

/* rest-screen description toggle (Adam's request) */
ok("state.nextCueOpen exists", /nextCueOpen\s*:/.test(src));
ok("function toggleNextCue defined", /function\s+toggleNextCue\s*\(/.test(src));
ok("rest screen renders the description toggle", /VIEW DESCRIPTION/.test(src) && /HIDE DESCRIPTION/.test(src));
ok("session view renders the current cue", /cur\.cue/.test(src));

/* retest reminder (Adam's addition) - evaluated against fixtures */
const rsMatch = src.match(/var RETEST_MIN_DAYS = 28;[\s\S]*?function retestStatus\(\)[\s\S]*?\n\}/);
ok("retest reminder block extractable", !!rsMatch, "not found");
if (rsMatch) {
  ok("RETEST_MIN_DAYS is 28", /var RETEST_MIN_DAYS = 28;/.test(src));
  ok("RETEST_OVERDUE_DAYS is 42", /var RETEST_OVERDUE_DAYS = 42;/.test(src));
  try {
    const rs = {};
    vm.createContext(rs);
    vm.runInContext("var state = {};" + rsMatch[0] +
      ";function probe(log){ state.calibrationLog = log; return retestStatus(); }", rs, { filename: "retest.js" });
    const daysAgo = function (n) {
      const d = new Date(); d.setDate(d.getDate() - n);
      const p = x => String(x).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    };
    ok("retestStatus returns null with an empty log", rs.probe([]) === null, JSON.stringify(rs.probe([])));
    const fresh = rs.probe([{ date: daysAgo(3) }]);
    ok("retestStatus: 3 days old is not due", fresh && fresh.days === 3 && fresh.due === false && fresh.overdue === false, JSON.stringify(fresh));
    const due = rs.probe([{ date: daysAgo(30) }]);
    ok("retestStatus: 30 days old is due, not overdue", due && due.days === 30 && due.due === true && due.overdue === false, JSON.stringify(due));
    const over = rs.probe([{ date: daysAgo(50) }]);
    ok("retestStatus: 50 days old is overdue", over && over.days === 50 && over.due === true && over.overdue === true, JSON.stringify(over));
    const latest = rs.probe([{ date: daysAgo(60) }, { date: daysAgo(5) }]);
    ok("retestStatus reads the NEWEST entry", latest && latest.days === 5 && latest.due === false, JSON.stringify(latest));
  } catch (e) { ok("retestStatus evaluates with fixtures", false, e.message); }
}
ok("renderCalibEntry renders the retest banner", /RETEST DUE/.test(src) && /RETEST OVERDUE/.test(src));

/* --- 6h. calibration mapping engine (v8.1, Oct 18 2026) ------------- */
/* computeDoses() must reproduce EVERY value shipped in PLAN v8.0 from the
   Oct 15 2026 measurements. If a rule is edited and the numbers drift, this
   fails. Spec: 2026-10-18-calibrate-mode-design.md section 5.3. */
{
  const rulesMatch = src.match(/var CAL_RULES = \{[\s\S]*?\n\};/);
  const maxMatch = src.match(/function calibMax[\s\S]*?\n\}/);
  const doseMatch = src.match(/function computeDoses[\s\S]*?\n\}/);
  const batMatch2 = src.match(/var BATTERY = (\[[\s\S]*?\n\]);/);
  ok("CAL_RULES block found", !!rulesMatch, "var CAL_RULES {...} not matched");
  ok("calibMax extractable", !!maxMatch, "not found");
  ok("computeDoses extractable", !!doseMatch, "not found");
  if (rulesMatch && maxMatch && doseMatch && batMatch2) {
    try {
      const es = {};
      vm.createContext(es);
      vm.runInContext("var BATTERY = " + batMatch2[1] + ";" + rulesMatch[0] + maxMatch[0] + doseMatch[0], es, { filename: "engine.js" });
      const CAL_RULES = es.CAL_RULES;
      ok("CAL_RULES has exactly 5 classes", Object.keys(CAL_RULES).length === 5, Object.keys(CAL_RULES).join(","));
      ["handstand", "skill_hold", "core_hold", "strength_reps", "fixed"].forEach(function (k) {
        ok("CAL_RULES." + k + " exists with a valid mode",
          !!CAL_RULES[k] && ["hold", "reps", "fixed"].indexOf(CAL_RULES[k].mode) > -1,
          JSON.stringify(CAL_RULES[k]));
      });

      /* the Oct 15 2026 battery, verbatim */
      const MEASURED = {
        handstand: { attempts: [11], variant: "chest-to-wall" },
        tucklever: { value: 12, variant: "tuck" },
        pike:      { value: 7,  variant: "feet-elevated" },
        diamond:   { value: 8,  variant: "full" },
        pullups:   { value: 5,  variant: "strict" },
        scapular:  { value: 9,  variant: "full hang" },
        hollow:    { value: 21, variant: "arms overhead" },
        pistol:    { left: 9, right: 9, variant: "assisted" },
        bulgarian: { left: 12, right: 12, variant: "feet elevated" }
      };
      /* the values actually shipped in PLAN v8.0 */
      const V80 = {
        handstand: { duration: 8 },
        tucklever: { duration: 6 },
        pike:      { label: "4-5 reps" },
        diamond:   { label: "5-6 reps" },
        pullups:   { label: "3 reps" },
        scapular:  { fixed: true, label: "5 reps" },
        hollow:    { duration: 14 },
        pistol:    { fixed: true, label: "3-5 / leg" },
        bulgarian: { label: "8-9 / leg" }
      };
      const got = es.computeDoses(MEASURED);
      Object.keys(V80).forEach(function (id) {
        ok("computeDoses reproduces v8.0 for " + id + " (" + JSON.stringify(V80[id]) + ")",
          JSON.stringify(got[id]) === JSON.stringify(V80[id]), "got " + JSON.stringify(got[id]));
      });

      /* degenerate cases (spec 5.4) */
      ok("max 0 -> NOT MEASURED flag",
        es.computeDoses({ pike: { value: 0 } }).pike.flag === "NOT MEASURED",
        JSON.stringify(es.computeDoses({ pike: { value: 0 } }).pike));
      ok("missing measurement -> NOT MEASURED flag",
        es.computeDoses({}).hollow.flag === "NOT MEASURED");
      ok("max below the reps floor -> single clamped value",
        es.computeDoses({ pike: { value: 3 } }).pike.label === "3 reps",
        JSON.stringify(es.computeDoses({ pike: { value: 3 } }).pike));
      ok("hold above the cap -> clamped to 30s",
        es.computeDoses({ handstand: { attempts: [40] } }).handstand.duration === 30);
      ok("skill_hold is uncapped (60s -> 33s)",
        es.computeDoses({ tucklever: { value: 60 } }).tucklever.duration === 33);
      ok("core_hold caps at 45s",
        es.computeDoses({ hollow: { value: 100 } }).hollow.duration === 45);
    } catch (e) { ok("calibration engine evaluates", false, e.message); }
  }
}

/* --- 6i. calibration overlay (v8.1) -------------------------------- */
/* The overlay is keyed by a STABLE movement id, never by exercise name,
   because the name changes when the variant does (spec 8.2). */
{
  const batMatch3 = src.match(/var BATTERY = (\[[\s\S]*?\n\]);/);
  const ovMatch = src.match(/function calibVariantConflict[\s\S]*?\n\}\s+function calibOverlayFor[\s\S]*?\n\}/);
  const geMatch = src.match(/function getEffective[\s\S]*?\n\}/);
  ok("calibOverlayFor extractable", !!ovMatch, "not found");
  ok("getEffective extractable", !!geMatch, "not found");
  ok("state.planCalibration exists", /planCalibration\s*:/.test(src));
  ok('references "plan-calibration"', src.indexOf('"plan-calibration"') > -1);
  ok("export payload includes planCalibration", /planCalibration:\s*state\.planCalibration/.test(src));

  /* every cal key on a PLAN exercise must be a known battery test id */
  if (PLAN && batMatch3) {
    const ids = [];
    const bs = {};
    vm.createContext(bs);
    vm.runInContext("var BATTERY = " + batMatch3[1], bs, { filename: "battery3.js" });
    bs.BATTERY.forEach(t => ids.push(t.id));
    const calKeys = [];
    DAYS.forEach(function (d) {
      const day = PLAN[d];
      if (!day || day.mode !== "session") return;
      ["warmup", "main", "cooldown"].forEach(function (sec) {
        (day[sec] || []).forEach(function (ex) { if (ex.cal) calKeys.push(ex.cal); });
      });
    });
    const unknown = calKeys.filter(k => ids.indexOf(k) < 0);
    ok("every cal key is a known battery test id", unknown.length === 0, unknown.join(","));
    const missing = ids.filter(id => calKeys.indexOf(id) < 0);
    ok("every battery test has at least one plan exercise", missing.length === 0, missing.join(","));
  }

  /* precedence, evaluated against a fixture: override > overlay > source */
  if (ovMatch && geMatch && batMatch3) {
    try {
      const os = {};
      vm.createContext(os);
      vm.runInContext(
        "var BATTERY = " + batMatch3[1] + ";" +
        "var PLAN = { Monday: { mode:'session', warmup:[], main:[{name:'Pike push-ups (elevated feet)', cal:'pike', type:'reps', label:'4-5 reps'}], cooldown:[] } };" +
        "var state = { overrides:{}, planCalibration:{ doses:{ pike:{ label:'6-8 reps' } } } };" +
        "function overrideKey(d,s,i){ return d+'|'+s+'|'+i; }" +
        ovMatch[0] + geMatch[0] +
        ";function probe(ov){ state.overrides = ov; return getEffective('Monday','MAIN',0); }",
        os, { filename: "overlay.js" });
      const src0 = os.probe({});
      ok("overlay beats the plan source", src0.label === "6-8 reps", JSON.stringify(src0));
      const ovr = os.probe({ "Monday|MAIN|0": { label: "9 reps" } });
      ok("user override beats the overlay", ovr.label === "9 reps", JSON.stringify(ovr));
      ok("the base name survives the merge", src0.name === "Pike push-ups (elevated feet)", src0.name);
    } catch (e) { ok("calibOverlayFor evaluates with a fixture", false, e.message); }
  }

  /* an exercise with no cal key is untouched by a populated overlay */
  if (ovMatch && geMatch) {
    try {
      const ns = {};
      vm.createContext(ns);
      vm.runInContext(
        "var BATTERY = [];" +
        "var PLAN = { Monday: { mode:'session', warmup:[], main:[{name:'Shoulder CARs', type:'time', duration:90}], cooldown:[] } };" +
        "var state = { overrides:{}, planCalibration:{ doses:{ shoulder:{ duration: 5 } } } };" +
        "function overrideKey(d,s,i){ return d+'|'+s+'|'+i; }" +
        ovMatch[0] + geMatch[0] +
        ";var out = getEffective('Monday','MAIN',0);",
        ns, { filename: "nocal.js" });
      ok("an exercise with no cal key is untouched by the overlay",
        ns.out.duration === 90, JSON.stringify(ns.out));
    } catch (e) { ok("no-cal passthrough evaluates", false, e.message); }
  }
}

/* --- 6j. movement tags for variant names (v8.1) -------------------- */
/* If a retest moves Adam from assisted to box pistols, the plan name becomes
   "Pistol squat (box)", which has no MUSCLE_TAGS entry - and the volume panel
   would silently count it as ZERO. CAL_MOVEMENT_TAGS tags by MOVEMENT so a
   variant name still resolves. Spec section 9. */
{
  const mtMatch = src.match(/var CAL_MOVEMENT_TAGS = \{[\s\S]*?\n\};/);
  const revMatch = src.match(/var CAL_NAME_TO_MOVEMENT = \(function\(\)\{[\s\S]*?\n\}\)\(\);/);
  const fnMatch = src.match(/function muscleTagFor[\s\S]*?\n\}/);
  const batMatch4 = src.match(/var BATTERY = (\[[\s\S]*?\n\]);/);
  ok("CAL_MOVEMENT_TAGS block found", !!mtMatch, "not matched");
  ok("CAL_NAME_TO_MOVEMENT block found", !!revMatch, "not matched");
  ok("muscleTagFor extractable", !!fnMatch, "not found");
  ok("the volume panel uses muscleTagFor", /muscleTagFor\(sl\.exercise\)/.test(src));
  ok("the EXERCISE MAPPING panel still renders MUSCLE_TAGS keys only",
    /Object\.keys\(MUSCLE_TAGS\)\.forEach/.test(src));

  if (mtMatch && revMatch && fnMatch && batMatch4) {
    try {
      const ms = {};
      vm.createContext(ms);
      vm.runInContext(
        "var MUSCLE_TAGS = { 'Pistol squat (assisted)': { quads:3, glutes:2, core:1 }, 'Ring rows': { lats:2 } };" +
        "var BATTERY = " + batMatch4[1] + ";" +
        mtMatch[0] + revMatch[0] + fnMatch[0],
        ms, { filename: "tags.js" });
      const ids = ms.BATTERY.map(t => t.id);
      const keys = Object.keys(ms.CAL_MOVEMENT_TAGS);
      ok("CAL_MOVEMENT_TAGS keys are exactly the battery test ids",
        keys.length === ids.length && ids.every(id => keys.indexOf(id) > -1),
        "keys=" + keys.join(",") + " ids=" + ids.join(","));
      const badKeys = [];
      keys.forEach(function (k) {
        Object.keys(ms.CAL_MOVEMENT_TAGS[k] || {}).forEach(function (mg) {
          if (MUSCLE_GROUPS_LIST.indexOf(mg) < 0) badKeys.push(k + "." + mg);
        });
      });
      ok("every muscle key in CAL_MOVEMENT_TAGS is a known MUSCLE_GROUPS entry",
        badKeys.length === 0, badKeys.join(" | "));
      const empty = keys.filter(k => Object.keys(ms.CAL_MOVEMENT_TAGS[k] || {}).length === 0);
      ok("no CAL_MOVEMENT_TAGS entry is empty", empty.length === 0, empty.join(","));

      /* the reverse index must be total over every variantNames value */
      const allNames = [];
      ms.BATTERY.forEach(t => { if (t.variantNames) Object.keys(t.variantNames).forEach(k => allNames.push(t.variantNames[k])); });
      const unresolved = allNames.filter(n => !ms.CAL_NAME_TO_MOVEMENT[n]);
      ok("the reverse index resolves every variant name", unresolved.length === 0, unresolved.join(","));

      /* the behaviour that matters: a variant name still counts volume */
      const box = ms.muscleTagFor("Pistol squat (box)");
      ok("a variant name resolves to its movement's tags", !!box && box.quads === 3, JSON.stringify(box));
      const exact = ms.muscleTagFor("Pistol squat (assisted)");
      ok("an exact MUSCLE_TAGS hit still wins", !!exact && exact.quads === 3, JSON.stringify(exact));
      ok("an unknown name resolves to null", ms.muscleTagFor("Nonexistent Exercise") === null);
    } catch (e) { ok("movement tags evaluate with a fixture", false, e.message); }
  }
}

/* --- 6k. review gate and apply (v8.1) ------------------------------ */
{
  ["calibReviewRows", "calibApply", "calibSkipApply", "calibCurrentFor", "calibDoseText", "calibRegression"].forEach(function (fn) {
    ok("function " + fn + " defined", new RegExp("function\\s+" + fn + "\\s*\\(").test(src), "not found");
  });
  ok('review phase is reachable', /phase === "review"/.test(src));
  ok("review screen offers APPLY and DISCARD", /APPLY TO PLAN/.test(src) && /DISCARD - CHANGE NOTHING/.test(src));
  ok("review screen renders the three flags",
    /REGRESSION/.test(src) && /STRUCTURAL/.test(src) && /NOT MEASURED/.test(src));
  ok("review is not persisted as an in-progress run",
    /phase === "done" \|\| state\.calib\.viewOnly/.test(src) || /viewOnly/.test(src.slice(src.indexOf("function saveCalibState"), src.indexOf("function startCalibration"))));

  /* the retired handstand trigger must be ABSENT from the trigger table */
  const regMatch = src.match(/var CAL_REGRESSION = \{[\s\S]*?\n\};/);
  ok("CAL_REGRESSION block found", !!regMatch, "not matched");
  if (regMatch) {
    ok("the handstand regression trigger is retired", regMatch[0].indexOf("handstand") < 0,
      "handstand still present in CAL_REGRESSION");
    ["tucklever", "pike", "hollow", "pistol", "pullups"].forEach(function (id) {
      ok("CAL_REGRESSION keeps the " + id + " trigger", regMatch[0].indexOf(id) > -1);
    });
  }

  /* the trigger behaviour, evaluated */
  const regFn = src.match(/function calibRegression[\s\S]*?\n\}/);
  if (regMatch && regFn) {
    try {
      const rs = {};
      vm.createContext(rs);
      vm.runInContext("function calibMax(r){ if (r == null) return null; if (r.value != null) return r.value; if (r.left != null && r.right != null) return Math.max(r.left, r.right); return null; }" +
        regMatch[0] + regFn[0] +
        ";function probe(id, v){ return calibRegression(id, { value: v }); }",
        rs, { filename: "reg.js" });
      ok("pull-ups at 2 reps triggers", rs.probe("pullups", 2) === true);
      ok("pull-ups at 3 reps does not trigger", rs.probe("pullups", 3) === false);
      ok("tuck lever at 4s triggers", rs.probe("tucklever", 4) === true);
      ok("pike at 4 reps triggers", rs.probe("pike", 4) === true);
      ok("hollow at 19s triggers", rs.probe("hollow", 19) === true);
      ok("handstand is not a trigger any more", rs.probe("handstand", 5) === false);
    } catch (e) { ok("calibRegression evaluates with a fixture", false, e.message); }
  }
}

/* --- 6l. stale overlay banner (v8.1) ------------------------------- */
{
  ok("function calibStale defined", /function\s+calibStale\s*\(/.test(src));
  ok("stale banner copy present", /CALIBRATION STALE/.test(src));
  const staleMatch = src.match(/function calibStale[\s\S]*?\n\}/);
  if (staleMatch) {
    try {
      const ss = {};
      vm.createContext(ss);
      vm.runInContext("var APP_VERSION = 'v8.1';var state = { planCalibration: null };" + staleMatch[0] +
        ";function probe(pc){ state.planCalibration = pc; return calibStale(); }",
        ss, { filename: "stale.js" });
      ok("no overlay -> not stale", ss.probe(null) === false);
      ok("matching version -> not stale", ss.probe({ planVersion: "v8.1", doses: {} }) === false);
      ok("older version -> stale", ss.probe({ planVersion: "v8.0", doses: {} }) === true);
      ok("missing planVersion -> stale", ss.probe({ doses: {} }) === true);
    } catch (e) { ok("calibStale evaluates with a fixture", false, e.message); }
  }
}

/* --- 6m. export patch (v8.1) --------------------------------------- */
{
  const patchMatch = src.match(/function formatCalibrationPatch[\s\S]*?\n\}/);
  const rulesMatch2 = src.match(/var CAL_RULES = \{[\s\S]*?\n\};/);
  const maxMatch2 = src.match(/function calibMax[\s\S]*?\n\}/);
  const doseMatch2 = src.match(/function computeDoses[\s\S]*?\n\}/);
  const regMatch2 = src.match(/var CAL_REGRESSION = \{[\s\S]*?\n\};/);
  const regFn2 = src.match(/function calibRegression[\s\S]*?\n\}/);
  const batMatch5 = src.match(/var BATTERY = (\[[\s\S]*?\n\]);/);
  const verForPatch = html.match(/var APP_VERSION = "(v[0-9]+(?:\.[0-9]+)*)"/);
  const realVer = verForPatch ? verForPatch[1] : "v8.1";
  ok("formatCalibrationPatch extractable", !!patchMatch, "not found");
  ok("COPY RESULTS writes the patch too", /formatCalibrationPatch/.test(src.slice(src.indexOf("function copyCalibrationResults"), src.indexOf("function copyCalibrationResults") + 900)));

  if (patchMatch && rulesMatch2 && maxMatch2 && doseMatch2 && regMatch2 && regFn2 && batMatch5) {
    try {
      const ps = {};
      vm.createContext(ps);
      vm.runInContext(
        "var BATTERY = " + batMatch5[1] + ";var APP_VERSION = " + JSON.stringify(realVer) + ";" + rulesMatch2[0] + maxMatch2[0] + doseMatch2[0] + regMatch2[0] + regFn2[0] + patchMatch[0],
        ps, { filename: "patch.js" });
      const MEASURED = {
        handstand: { attempts: [11], variant: "chest-to-wall" },
        tucklever: { value: 12, variant: "tuck" },
        pike:      { value: 7,  variant: "feet-elevated" },
        diamond:   { value: 8,  variant: "full" },
        pullups:   { value: 5,  variant: "strict" },
        ringrows:  { value: 14, variant: "feet elevated" },
        scapular:  { value: 9,  variant: "full hang" },
        hollow:    { value: 21, variant: "arms overhead" },
        pistol:    { left: 9, right: 9, variant: "assisted" },
        bulgarian: { left: 12, right: 12, variant: "feet elevated" }
      };
      const out = ps.formatCalibrationPatch(MEASURED, "2026-10-15");
      ok("patch starts with a PATCH + date line", /^PATCH 2026-10-15/.test(out), out.split("\n")[0]);
      ok("patch names the plan version", out.split("\n")[0] === "PATCH 2026-10-15 (plan " + realVer + ")", out.split("\n")[0]);
      ok("patch carries the handstand dose", /handstand: duration 8/.test(out), out);
      ok("patch carries a reps label", /pike: label 4-5 reps/.test(out), out);
      ok("patch carries a per-leg label", /bulgarian: label 8-9 \/ leg/.test(out), out);
      ok("patch carries the variant when the rung is not the plan's", /pistol: label 3-5 \/ leg variant assisted/.test(out), out);
      ok("patch is ASCII", out.split("").every(c => c.charCodeAt(0) <= 126), "non-ascii present");

      /* a triggered movement is flagged, not swapped */
      const trig = ps.formatCalibrationPatch({ pullups: { value: 2, variant: "strict" } }, "2026-10-15");
      ok("patch flags a regression trigger", /FLAG regression: pullups/.test(trig), trig);
    } catch (e) { ok("formatCalibrationPatch evaluates with a fixture", false, e.message); }
  }
}

/* --- 6n. v8.3 plan change (Oct 21 2026): one-leg hollow + assisted tuck lever --- */
/* Adam: "Hollow body holds will be one leg hollow body holds but increase the
   time. And tuck front lever will be assited tucked front lever."
   Settled with him: one-leg hollow at 20s, legs alternating every set;
   band-assisted tuck front lever at 12s on the same two pulling days.
   Two consequences beyond the plan text: the battery needs a "one-leg"
   hollow variant (so a retest can measure the variation the plan actually
   uses), and the calibration overlay must stop pushing a two-leg hollow
   dose or a plain-tuck dose onto the new movements. */
if (PLAN) {
  const items = [];
  DAYS.forEach(function (d) {
    const day = PLAN[d];
    if (!day || day.mode !== "session") return;
    ["warmup", "main", "cooldown"].forEach(function (sec) {
      (day[sec] || []).forEach(function (ex) { items.push({ day: d, sec: sec, ex: ex }); });
    });
  });
  const find = function (n) { return items.filter(function (i) { return i.ex.name === n; }); };
  const dose = function (ex) { return ex.type === "time" ? ex.duration + "s" : ex.label; };

  ok("the two-leg hollow is no longer prescribed", find("Hollow body hold (arms at sides)").length === 0,
    find("Hollow body hold (arms at sides)").map(function (i) { return i.day + "." + i.sec; }).join(", "));
  ok("the unassisted tuck lever is no longer prescribed", find("Tuck front lever holds").length === 0,
    find("Tuck front lever holds").map(function (i) { return i.day + "." + i.sec; }).join(", "));

  const oneLeg = find("One-leg hollow body hold");
  ok("one-leg hollow body hold is a main item on 4 days",
    oneLeg.length === 4 && oneLeg.every(function (i) { return i.sec === "main"; }),
    oneLeg.map(function (i) { return i.day + "." + i.sec; }).join(", "));
  ok("one-leg hollow body hold keeps the hollow cal key and a 20s dose",
    oneLeg.length === 4 && oneLeg.every(function (i) { return i.ex.cal === "hollow" && i.ex.type === "time" && i.ex.duration === 20; }),
    oneLeg.map(function (i) { return i.day + " " + dose(i.ex); }).join(", "));
  ok("one-leg hollow body hold tells him to switch legs",
    oneLeg.length > 0 && oneLeg.every(function (i) { return /leg/i.test(i.ex.cue) && /switch/i.test(i.ex.cue); }),
    oneLeg.length ? oneLeg[0].ex.cue : "no cue");

  const assisted = find("Band-assisted tuck front lever holds");
  ok("band-assisted tuck front lever is a main item on Wednesday and Saturday",
    assisted.length === 2 && assisted.map(function (i) { return i.day; }).join(",") === "Wednesday,Saturday",
    assisted.map(function (i) { return i.day; }).join(","));
  ok("band-assisted tuck front lever keeps the tucklever cal key and a 12s dose",
    assisted.length === 2 && assisted.every(function (i) { return i.ex.cal === "tucklever" && i.ex.type === "time" && i.ex.duration === 12; }),
    assisted.map(function (i) { return i.day + " " + dose(i.ex); }).join(", "));
  ok("band-assisted tuck front lever names the band in its cue",
    assisted.length > 0 && assisted.every(function (i) { return /band/i.test(i.ex.cue); }),
    assisted.length ? assisted[0].ex.cue : "no cue");
  ok("the assisted lever keeps its set counts (Wed 5, Sat 4)",
    assisted.length === 2 && assisted[0].ex.sets === 5 && assisted[1].ex.sets === 4,
    assisted.map(function (i) { return i.day + " " + i.ex.sets + " sets"; }).join(", "));

  /* the warm-up ramp must stay below the new main dose */
  const warm = items.filter(function (i) { return i.sec === "warmup" && i.ex.name.indexOf("Hollow hold") === 0; });
  ok("warm-up hollow holds stay below the 20s main dose",
    warm.length === 2 && warm.every(function (i) { return i.ex.duration < 20; }),
    warm.map(function (i) { return i.ex.name + "=" + dose(i.ex); }).join(", "));

  /* the muscle tags follow the rename - the volume panel must not count
     the new movements as zero, and the old keys must not linger as
     orphans (the old names still resolve through the variant fallback) */
  const tagStart = src.indexOf("var MUSCLE_TAGS");
  const tagEnd = src.indexOf("var MUSCLE_GROUPS");
  let TAGS = null;
  try {
    const ts = {};
    vm.createContext(ts);
    vm.runInContext(src.slice(tagStart, tagEnd), ts, { filename: "tags-v83.js" });
    TAGS = ts.MUSCLE_TAGS;
  } catch (e) { TAGS = null; }
  ok("MUSCLE_TAGS block still evaluates for the v8.3 names", TAGS !== null);
  ok("the new movements carry muscle tags",
    TAGS && !!TAGS["One-leg hollow body hold"] && !!TAGS["Band-assisted tuck front lever holds"],
    TAGS ? Object.keys(TAGS).join(",") : "not evaluable");
  ok("the old tag keys are gone (history resolves through the variant fallback)",
    TAGS && !TAGS["Hollow body hold (arms at sides)"] && !TAGS["Tuck front lever holds"]);

  /* the battery must offer the variation the plan uses, and it must be
     the DEFAULT chip so the next retest measures the right thing */
  const batMatch5 = src.match(/var BATTERY = (\[[\s\S]*?\n\]);/);
  ok("BATTERY block found for the v8.3 check", !!batMatch5);
  if (batMatch5) {
    const bs = {};
    vm.createContext(bs);
    vm.runInContext("var BATTERY = " + batMatch5[1], bs, { filename: "battery-v83.js" });
    const hollow = bs.BATTERY.filter(function (t) { return t.id === "hollow"; })[0];
    ok("the hollow battery test offers a one-leg variant",
      hollow && hollow.variants.indexOf("one-leg") > -1, hollow ? hollow.variants.join(",") : "no hollow test");
    ok("the one-leg hollow variant maps to the plan exercise name",
      hollow && hollow.variantNames && hollow.variantNames["one-leg"] === "One-leg hollow body hold",
      hollow ? JSON.stringify(hollow.variantNames) : "no hollow test");
    ok("one-leg is the default hollow variant (the retest measures the plan's variation)",
      hollow && hollow.variants[0] === "one-leg", hollow ? hollow.variants.join(",") : "no hollow test");
  }
}

/* --- 6o. the overlay must not push a dose onto a different variant --- */
/* The plan now prescribes the one-leg hollow and the band-assisted tuck.
   A battery result measured on the two-leg hollow or the plain tuck
   describes a DIFFERENT exercise, so its dose must not be applied to
   these two - it would silently overwrite Adam's new prescription. */
{
  const batMatch6 = src.match(/var BATTERY = (\[[\s\S]*?\n\]);/);
  const ovMatch = src.match(/function calibVariantConflict[\s\S]*?\n\}\s+function calibOverlayFor[\s\S]*?\n\}/);
  const geMatch = src.match(/function getEffective[\s\S]*?\n\}/);
  ok("calibOverlayFor extractable for the variant gate", !!ovMatch, "not found");
  ok("getEffective extractable for the variant gate", !!geMatch, "not found");
  if (batMatch6 && ovMatch && geMatch) {
    try {
      const vs = {};
      vm.createContext(vs);
      vm.runInContext(
        "var BATTERY = " + batMatch6[1] + ";" +
        "var PLAN = { Monday: { mode:'session', warmup:[], main:[" +
        "  {name:'One-leg hollow body hold', cal:'hollow', type:'time', duration:20, sets:3, rest:60}," +
        "  {name:'Band-assisted tuck front lever holds', cal:'tucklever', type:'time', duration:12, sets:5, rest:90}" +
        "], cooldown:[] } };" +
        "var state = { overrides:{} };" +
        "function overrideKey(d,s,i){ return d+'|'+s+'|'+i; }" +
        ovMatch[0] + geMatch[0] +
        ";function probe(doses){ state.planCalibration = { doses: doses }; return [getEffective('Monday','MAIN',0), getEffective('Monday','MAIN',1)]; }",
        vs, { filename: "variant-gate.js" });
      const twoLeg = vs.probe({ hollow: { duration: 14, variant: "arms at sides" } });
      ok("a two-leg hollow dose does not touch the one-leg hollow",
        twoLeg[0].duration === 20 && twoLeg[0].name === "One-leg hollow body hold", JSON.stringify(twoLeg[0]));
      const oneLegDose = vs.probe({ hollow: { duration: 18, variant: "one-leg" } });
      ok("a one-leg hollow dose DOES apply to the one-leg hollow",
        oneLegDose[0].duration === 18 && oneLegDose[0].name === "One-leg hollow body hold", JSON.stringify(oneLegDose[0]));
      const plainTuck = vs.probe({ tucklever: { duration: 6, variant: "tuck" } });
      ok("a plain-tuck dose does not touch the band-assisted tuck",
        plainTuck[1].duration === 12 && plainTuck[1].name === "Band-assisted tuck front lever holds", JSON.stringify(plainTuck[1]));
      const bandTuck = vs.probe({ tucklever: { duration: 14, variant: "band-assisted tuck" } });
      ok("a band-assisted tuck dose DOES apply to the band-assisted tuck",
        bandTuck[1].duration === 14 && bandTuck[1].name === "Band-assisted tuck front lever holds", JSON.stringify(bandTuck[1]));
      const noVariant = vs.probe({ hollow: { duration: 16 } });
      ok("a dose with no measured variant still applies (it is not a variant conflict)",
        noVariant[0].duration === 16, JSON.stringify(noVariant[0]));
    } catch (e) { ok("the variant gate evaluates with a fixture", false, e.message); }
  }
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

/* --- 9. laptop sync engine (lockd) -------------------------------- */
{
  ok("APP_VERSION bumped to v8.3", /var APP_VERSION = "v8\.3"/.test(src));
  ok("defines lockdConfigured", /function\s+lockdConfigured\s*\(/.test(src));
  ok("defines queueLockdSync", /function\s+queueLockdSync\s*\(/.test(src));
  ok("defines syncToLaptop", /function\s+syncToLaptop\s*\(/.test(src));
  ok("defines lockdStatusText", /function\s+lockdStatusText\s*\(/.test(src));
  ok("listens for postMessage events", /window\.addEventListener\("message"/.test(src));
  ok("guards on data.source === lockd", src.includes('data.source === "lockd"') || src.includes('data.source!=="lockd"') || src.includes('d.source !== "lockd"'));
  ok("queueLockdSync called from logCompletion", /logCompletion[\s\S]{0,800}queueLockdSync\(/.test(src));
  ok("uses window.open for the popup handshake", src.includes("window.open("));
  ok("persists pending sync via Storage under lockd-pending-sync",
     src.includes('"lockd-pending-sync"') && /Storage\.set\("lockd-pending-sync"/.test(src));
  ok("config field laptopSync present", src.includes("laptopSync"));
  /* Reject ANY arrow function - a bare-expression arrow (x => x) is still
     modern JS and must not slip past a pattern that only catches => { or => (. */
  ok("no arrow functions in index.html (ES5)", !/=>/.test(src));
  ok("no const/let declarations (ES5)", !/\b(const|let)\s+[A-Za-z_$]/.test(src));
  /* Pending lifecycle: cleared on ok AND on stale, KEPT on denied. */
  ok("pending cleared on ok, kept on denied",
     /d\.status === "ok"[\s\S]{0,120}clearPendingLockdSync\(/.test(src));
  ok("stale clears the pending too",
     /d\.status === "stale"[\s\S]{0,120}clearPendingLockdSync\(/.test(src));
  ok("no window opened when nothing is pending",
     /if \(!PENDING_SYNC\)[\s\S]{0,120}return(\s+false)?;/.test(src));

  /* --- 9b. Task 8: SYNC button + LAPTOP SYNC panel -------------------
     Slices keep these non-vacuous: "syncToLaptop" already exists as a
     function definition and "LAPTOP SYNC" already appears in the engine
     comment block - both must show up in the RIGHT render function. */
  const renderCompleteSrc = src.slice(src.indexOf("function renderComplete"), src.indexOf("function renderStats"));
  const renderOverviewSrc = src.slice(src.indexOf("function renderOverview"), src.indexOf("function renderComplete"));
  const saveCfgSrc = src.slice(src.indexOf("function saveLockdConfig"), src.indexOf("function queueLockdSync"));
  ok("completion screen renders SYNC TO LAPTOP button", src.includes("SYNC TO LAPTOP"));
  ok("SYNC button appears before RETURN in renderComplete",
     (() => {
       const a = renderCompleteSrc.indexOf('onclick="syncToLaptop()"');
       const b = renderCompleteSrc.indexOf("returnFromComplete()");
       return a > 0 && b > 0 && a < b;
     })());
  ok("overview renders LAPTOP SYNC panel", renderOverviewSrc.includes("LAPTOP SYNC"));
  ok("panel saves url and token",
     renderOverviewSrc.includes("saveLaptopSyncPanel()") &&
     /Storage\.set\("laptop-sync"/.test(saveCfgSrc));
  ok("panel has url input", /type\s*=\s*"url"/.test(renderOverviewSrc));
}

/* --- 9c. AUTO-SYNC: the workout syncs by itself -------------------- */
{
  ok("defines autoSyncToLaptop", /function\s+autoSyncToLaptop\s*\(/.test(src));
  ok("defines setLockdAutoSync", /function\s+setLockdAutoSync\s*\(/.test(src));
  ok("defines lockdSyncHeadline", /function\s+lockdSyncHeadline\s*\(/.test(src));
  ok("logCompletion triggers the auto sync", /logCompletion[\s\S]{0,900}autoSyncToLaptop\(/.test(src));
  ok("the auto sync is NOT deferred through a timer",
     !/setTimeout\(\s*function\s*\(\)\s*\{\s*autoSyncToLaptop/.test(src));
  const renderCompleteSrc = src.slice(src.indexOf("function renderComplete"), src.indexOf("function renderStats"));
  ok("completion screen shows a sync headline", renderCompleteSrc.includes("lockdSyncHeadline()"));
  ok("overview panel shows a sync headline",
     src.slice(src.indexOf("function renderOverview"), src.indexOf("function renderComplete")).includes("lockdSyncHeadline()"));
}

/* --- summary ------------------------------------------------------- */
console.log("\n" + pass + " passed, " + failures.length + " failed");
if (failures.length) { console.log("failures:"); failures.forEach(f => console.log(" - " + f)); process.exit(1); }
