#!/usr/bin/env node
/* THE LANDING GATE: every check that should pass, one at a time, each with a ceiling.
 *
 *   node scripts/gate.mjs [--who <session>] [--only <words> | --affected <base>] [--list]
 *       --affected <base>: only the checks the files changed since <base> can affect (scripts/lib/affected.mjs; what each
 *       check reads is in HARNESSES.md, "What each check reads"), with why each runs.
 *   node scripts/gate.mjs --serve [--port <n>]   the gate's server alone, kept up until this is
 *                                      stopped: also a lane's server to look at the app on, with
 *                                      the made-up trip (the port must be free; the one a thousand
 *                                      above it is the inspector's)
 *
 * On a machine with a queue for headless browsers (WGP_QUEUE), the browser checks go through it
 * (scripts/lib/browser.mjs refuses a launch outside it there), and this starts each of them there;
 * run it with the command sandbox off. On a machine without one, this runs them itself, one at a
 * time. Either way they need Chrome for Testing: node scripts/install-check-chrome.mjs.
 *
 * ITS OWN SERVER, ITS DATABASE MADE FROM NOTHING. The gate starts a server of its own on a free
 * port (scripts/lib/gate_db.mjs): the migrations, then the made-up trip (seed/demo-trip.json)
 * put in through the routes, with its four made-up people. Every check marked "trip" below
 * drives that server as those people (scripts/lib/gate_trip.mjs), and it is stopped and
 * removed when the gate ends. No lane's dev server and no kept database is read: WGP_BASE in
 * the environment is not looked at. To run checks by hand against one server, `--serve` keeps
 * it up and prints the two settings to give them; a gate started with those settings (a
 * WGP_GATE_CARD whose server answers) uses that server and leaves it running.
 *
 * WHY A SCRIPT. The checks share one server and one database, so they run in turn, and a
 * turn that never ends used to park everything behind it without a word. Three ceilings now:
 * the launcher ends a harness whose DevTools call is never answered (WGP_CALL_CEILING_S) or
 * that runs too long (WGP_RUN_CEILING_S), naming the call; and this ends whatever is still
 * there after WGP_GATE_CEILING_S (1000 s), which is the backstop for a check that hangs
 * somewhere the launcher cannot see. And a check that has said its end (its tally, "harness
 * error", FATAL, STOPPED) and then writes nothing for WGP_GATE_LINGER_S (15 s) while still
 * running is ended and red: "finished but didn't exit: left something open" (plant:
 * WGP_GATE_PLANT=linger, a check that prints its tally and never exits).
 *
 * A LAPTOP THAT SLEEPS stops every clock here at once. The gate notices the jump, says how
 * long the machine slept beside the check that sat through it, and runs that check once more
 * if it failed: a failure across a sleep is not evidence about the code.
 *
 * THE TRIP'S ROWS. A check removes only rows it made, each by the id it recorded when it made
 * it. The gate reads the key of every row of the made-up trip before and after each check
 * that drives it; a check that leaves a row of the trip gone, or a row of its own behind,
 * has failed, whatever its tally says, and its line names the table and the rows.
 *
 * WHAT IT LEAVES. A log per check in WGP_GATE_LOGS (default: a temp folder, printed), and the
 * list of tracked files a check rewrote (some older checks still write stills into docs/):
 * put those back with `git checkout -- docs` before committing.
 *
 * The list below is the gate. scripts/HARNESSES.md says what each covers and why the checks
 * that are not on it are red.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CEILING_EXIT, queueOf } from "./lib/browser.mjs";
import { pick, nameOf } from "./lib/affected.mjs";
import net from "node:net";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

// A check that starts a server of its own on a fixed default port is given `--port FREE`: the gate picks a free port
// for it just before it starts, so two lanes' gates never meet on one port (21 Nov). The same rule as
// checks/lib/server.mjs freePort (the port, the ten above it for its stand-ins, and each one's inspector a thousand up,
// between 20000 and the OS's own range), written here rather than imported: that module loads checks/lib/far.mjs, which
// draws its pictures as it loads (2 s, and now and then a load that never returned, 21 Nov).
const FREE = "<free port>";
const SPAN = 10;
const portFree = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once("error", () => resolve(false));
  probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => probe.close(() => resolve(true)));
});
async function freePort({ avoid = [] } = {}) {
  for (let i = 0; i < 60; i++) {
    const p = 20000 + Math.floor(Math.random() * (49152 - 1000 - SPAN - 20000));
    if (avoid.some((q) => Math.abs(q - p) <= SPAN)) continue;
    const span = Array.from({ length: SPAN + 1 }, (_, k) => [p + k, p + 1000 + k]).flat();
    if ((await Promise.all(span.map(portFree))).every(Boolean)) return p;
  }
  throw new Error("no free port for a check's server in 60 tries between 20000 and 48142");
}

// [script, arguments, needs a browser, drives the gate's own server and its trip]
export const GATE = [
  ["test-browser-launcher.mjs", [], false],
  ["test-browser-launcher.mjs", ["--browser"], true, "trip"],
  ["split_math_check.mjs", [], false],
  ["hours_check.mjs", [], false],
  ["zone_chip_check.mjs", [], false],
  ["place_kinds_check.mjs", [], false],
  ["fonts_check.mjs", [], false],
  ["contact_check.mjs", [], false],
  ["ds_theme_check.mjs", [], false],
  ["ds_links_check.mjs", [], false],
  ["logo_check.mjs", [], false],
  ["palette_check.mjs", [], false],
  ["appearance_check.mjs", [], false],
  ["picture_check.mjs", [], false],
  ["picture_format_check.mjs", [], false],
  ["collage_layout_test.mjs", [], false],
  ["sw_topup_test.mjs", [], false],
  ["sw_version_check.mjs", [], false],
  ["browser_lock_test.mjs", [], false],
  ["affected_test.mjs", [], false],
  // Every route still answers as recorded (checks/parity: its own server on a free port, its own empty database).
  // A landing that adds a public file or changes what a page serves records it again (checks/parity/README.md).
  ["../checks/parity/run.mjs", ["--compare", "checks/parity/golden.json"], false],
  ["collage_ground_check.mjs", [], false],
  ["theme_contrast.js", [], false],
  ["board_words_check.mjs", [], false],
  ["trip_here_check.mjs", [], false],
  ["old_queue_check.mjs", [], false],
  ["areas_check.mjs", [], false],
  ["plan_form_check.mjs", [], false],
  ["place_form_check.mjs", [], false],
  ["towns_check.mjs", [], false],
  ["bytes_check.mjs", [], false],
  ["taken_check.mjs", [], false],
  ["sw_navigation_check.mjs", [], true, "trip"],
  ["sw_limits_check.mjs", [], true, "trip"],
  // The API held and never answered (js/net.js), and a write given up applied once: its own server, one browser.
  ["api_limits_check.mjs", [], true],
  ["home_shell_check.mjs", [], true, "trip"],
  ["fab_clear_check.mjs", [], true, "trip"],
  // A dark phone with nothing chosen is Void, on every page; a theme chosen is kept.
  ["dark_default_check.mjs", [], true, "trip"],
  ["bar_check.mjs", [], true, "trip"],
  ["more_check.mjs", [], true, "trip"],
  // Report a bug: More's sheet and /report, what goes is what it shows, the screenshot redrawn (js/report-form.js).
  ["bug_report_check.mjs", [], true, "trip"],
  // No field zooms the page on iOS: every field the app shows, its computed font-size 16px or more (ds/controls.css).
  ["field_size_check.mjs", [], true, "trip"],
  // The trip's reference list: its button mirroring the +, the sheet, offline, two people (js/references.js).
  ["references_check.mjs", [], true, "trip"],
  ["logo_player_check.mjs", [], true, "trip"],
  ["pad_check.mjs", [], true, "trip"],
  ["picture_places_check.mjs", [], true, "trip"],
  ["design_check.mjs", [], true, "trip"],
  ["itinerary_ds_check.mjs", ["--static"], false],
  ["itinerary_ds_check.mjs", [], true],
  ["places_ds_check.mjs", ["--static"], false],
  ["places_ds_check.mjs", [], true],
  ["chat_ds_check.mjs", ["--static"], false],
  ["chat_ds_check.mjs", [], true],
  // A document given the assistant, in the app: its own server, a stand-in model and conversion.
  ["assistant_attach_check.mjs", [], true],
  ["photos_ds_check.mjs", ["--static"], false],
  ["photos_ds_check.mjs", [], true],
  ["panes_check.mjs", [], true, "trip"],
  ["split_table_check.mjs", [], true, "trip"],
  ["head_add_check.mjs", [], true, "trip"],
  ["a11y_check.mjs", [], true, "trip"],
  ["narrow_check.mjs", [], true, "trip"],
  ["a11y_public_check.mjs", [], true],
  ["narrow_public_check.mjs", [], true],
  ["keys_check.mjs", [], true, "trip"],
  ["turns_check.mjs", [], true, "trip"],
  ["pack_band_check.mjs", [], true, "trip"],
  ["itinerary_stays_check.mjs", [], true, "trip"],
  ["forget_check.mjs", [], true, "trip"],
  ["pack_lists_check.mjs", [], true, "trip"],
  ["pack_today_check.mjs", [], true, "trip"],
  ["packing_ds_check.mjs", [], true, "trip"],
  ["agenda_place_check.mjs", [], true, "trip"],
  ["agenda_today_check.mjs", [], true, "trip"],
  // A trip under way before its first plan: its own server, one browser, the real clock.
  ["agenda_started_check.mjs", [], true],
  // The money of where a trip goes: its own server, one browser at a time, a US phone.
  ["currency_where_check.mjs", [], true],
  // A trip's first screens with nothing in it yet: its own server, one browser at a time.
  ["first_screens_check.mjs", [], true],
  // What's yours on Your account (the export): its own servers, one browser at a time.
  ["export_card_check.mjs", [], true],
  ["map_arriving_check.mjs", [], true],
  ["toast_check.mjs", [], true, "trip"],
  ["deleted_member_check.mjs", [], true],
  ["guests_check.mjs", [], true],
  ["guest_words_check.mjs", [], true],
  ["stranger_fixes_check.mjs", [], true],
  ["board_memory_check.mjs", [], true],
  ["board_types_check.mjs", [], true],
  ["trips_app_check.mjs", [], true],
  ["where_check.mjs", [], true],
  ["first_focus_check.mjs", [], true, "trip"],
  ["plans_check.mjs", [], true],
  ["map_trip_check.mjs", [], true],
  ["map_keep_check.mjs", [], true],
  ["map_discs_check.mjs", [], true, "trip"],
  ["map_fit_check.mjs", [], true],
  ["units_check.mjs", [], true, "trip"],
  // The whole journey a new person makes (checks/journey/run.mjs): its own server on this
  // port, its own browsers. 8797 is no lane's dev server and no other check's.
  ["../checks/journey/run.mjs", ["--port", FREE], true],
  ["place_check.mjs", [], true],
  // A photo by hand on a place, a plan and the cover: its own server, two browsers; it makes its
  // photos once with ffmpeg (test patterns) and keeps them in the temp folder.
  ["photo_hand_check.mjs", [], true],
  // "Chat about this" on a place and a purchase: its own server, one browser.
  ["chat_about_check.mjs", [], true],
  // A memory's day: its own server, two browsers (and a third whose clock runs a month fast); its
  // photos made once with ffmpeg (test patterns) and given a made-up camera's time.
  ["memory_day_check.mjs", [], true],
  ["split_store_harness.mjs", [], true, "trip"],
  ["split_harness.mjs", [], true, "trip"],
  ["split_ui_harness.mjs", [], true, "trip"],
  ["split_fx_check.mjs", [], true, "trip"],
  ["split_wiring_check.mjs", [], true, "trip"],
  ["settle_check.mjs", [], true],
  ["memories_shell_check.mjs", [], true, "trip"],
  ["collage_export_check.mjs", [], true, "trip"],
  ["collage_video_export_check.mjs", [], true, "trip"],
  ["collage_layout_browser_check.mjs", [], true, "trip"],
  ["collage_look_check.mjs", [], true, "trip"],
  ["board_video_check.mjs", [], true, "trip"],
  ["board_camera_check.mjs", [], true, "trip"],
  ["board_wall_check.mjs", [], true, "trip"],
  ["share_lightbox_check.mjs", [], true, "trip"],
  ["standalone_states_check.mjs", ["--no-shots"], true, "trip"],
  ["sheet_grow_check.mjs", [], true, "trip"],
  ["sheet_tall_check.mjs", [], true, "trip"],
  ["screens_load_check.mjs", [], true, "trip"],
  // The location question is the person's to ask: no screen reads it by itself (a stand-in for the browser's location).
  ["geo_ask_check.mjs", [], true, "trip"],
  ["reinstall_hint_check.mjs", [], true, "trip"],
  ["shell_build_check.mjs", [], true],
  ["icon_names_check.mjs", [], false],
  ["webkit_stacking_check.mjs", [], true, "trip"],
  ["media_save_harness.js", [], true],
  ["captive_portal_check.js", [], true, "trip"],
  ["agenda_return_check.js", [], true, "trip"],
  ["feel_copy_walk.js", [], true, "trip"],
  ["places_chips_check.js", [], true, "trip"],
  ["v5_verify_C.js", [], true, "trip"],
  ["v7_probe_flash.js", [], true, "trip"],
  ["v7_probe_return.js", [], true, "trip"],
  // Checks with a server of their own that no gate ran until 21 Nov (three had gone stale behind one landing), in
  // checks/ by part of the app: each on a port picked as it starts (FREE above). check:mcp-sdk's three walks and
  // check:mcp-sdk-cimd's one are four rows of one script.
  ["../checks/accounts/browser.mjs", ["--port", FREE], true],
  ["../checks/accounts/signin-words.mjs", ["--port", FREE], true],
  ["../checks/billing/browser.mjs", ["--port", FREE], true],
  ["../checks/changes/screen.mjs", ["--port", FREE], true],
  ["../checks/chat/agenda.mjs", ["--port", FREE], true],
  ["../checks/chat/screen.mjs", ["--port", FREE], true],
  ["../checks/errors/browser.mjs", ["--port", FREE], true],
  ["../checks/install/browser.mjs", ["--port", FREE], true],
  ["../checks/live/browser.mjs", ["--port", FREE], true],
  ["../checks/live/client.mjs", ["--port", FREE], true],
  ["../checks/mcp/browser.mjs", ["--port", FREE], true],
  ["../checks/mcp/sdk-walk.mjs", ["--package", "sdk", "--port", FREE], true],
  ["../checks/mcp/sdk-walk.mjs", ["--package", "client", "--port", FREE], true],
  ["../checks/mcp/sdk-walk.mjs", ["--package", "client", "--era", "2026-07-28", "--port", FREE], true],
  ["../checks/mcp/sdk-walk.mjs", ["--package", "client", "--cimd", "--port", FREE], true],
  ["../checks/push/browser.mjs", ["--port", FREE], true],
  ["../checks/split/run.mjs", ["--port", FREE], true],
  ["../checks/trips/board-page.mjs", ["--port", FREE], true],
  ["../checks/trips/browser.mjs", ["--port", FREE], true],
  ["../checks/trips/receipts.mjs", ["--port", FREE], true],
  ["../checks/www/browser.mjs", ["--port", FREE], true],
  // The assistant's screens (wgp-assistant keeps it green) and a memory's photo and video through the composer: servers
  // of their own on ports they find themselves.
  ["assistant_screens_check.mjs", [], true],
  ["memories_upload_check.mjs", [], true],
];

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const only = arg("--only");
const who = arg("--who") || process.env.WGP_WHO || "gate";
// An --only with nothing in it would run every check (20 Nov: a list read from a file that wasn't there).
if (process.argv.includes("--only") && !(only || "").split(/[\s,]+/).some(Boolean)) { console.error("--only names no check: refused (an empty list would run the whole gate)"); process.exit(2); }
// Whose browsers these are: the launcher refuses to start one under another lane's landing lock (scripts/lib/browser.mjs).
if (!process.env.WGP_LANE) process.env.WGP_LANE = who;
const CEILING_S = Number(process.env.WGP_GATE_CEILING_S) || 1000;
// A CHECK THAT HAS SAID ITS END BUT HASN'T EXITED: its last line is its end (its tally, "harness error", FATAL, STOPPED)
// and it has written nothing for WGP_GATE_LINGER_S (15 s) since. It caught its error, or finished, and left something
// open that keeps node alive (21 Nov: memories_shell's error path kept its browser's socket open; the gate's turn waited
// 9 minutes). It is ended and is red: "finished but didn't exit: left something open". The silence is counted from its
// last line, so a check that prints a tally and then goes on to more work is never ended by this.
const LINGER_S = Number(process.env.WGP_GATE_LINGER_S) || 15;
const END_LINE = /^(harness error|FATAL|STOPPED)\b|\b\d+ passed, \d+ failed\b|^\d+\s*\/\s*\d+ passed\b/i;
// WGP_GATE_PLANT=linger puts a planted check first (scripts/lib/linger_plant.mjs): it prints its tally and never exits.
const GATE_PLANT = process.env.WGP_GATE_PLANT || "";
if (GATE_PLANT && GATE_PLANT !== "linger") { console.error("WGP_GATE_PLANT is linger"); process.exit(2); }
// The machine's queue for headless browsers, decided as the launcher decides it (scripts/lib/browser.mjs queueOf):
// the environment can name one, never take one away.
const QUEUE = queueOf();
// --affected <base>: the checks the files changed since <base> (committed or not) can affect, and why each runs.
const affected = arg("--affected");
if (process.argv.includes("--affected") && (!affected || affected.startsWith("--"))) { console.error("--affected needs the base to compare with (a branch or a sha)"); process.exit(2); }
if (affected && process.argv.includes("--only")) { console.error("--affected or --only, not both"); process.exit(2); }
let why = null;
if (affected) {
  const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let base;
  try { base = git("rev-parse", "--verify", `${affected}^{commit}`); } catch { console.error(`--affected ${affected}: no such commit here`); process.exit(2); }
  const changed = [...new Set(git("diff", "--name-only", "--no-renames", base).split("\n").concat(git("ls-files", "--others", "--exclude-standard").split("\n")).filter(Boolean))];
  const picked = pick(REPO, [...new Set(GATE.map(([script]) => nameOf(script)))], changed);
  why = new Map(picked.map((p) => [p.name, p.why]));
  console.log(`Affected against ${base.slice(0, 7)}: ${changed.length} file${changed.length === 1 ? "" : "s"} changed, ${why.size} of the gate's checks can be affected.`);
  for (const p of picked) console.log(`  ${p.name.padEnd(38)} ${p.why}`);
}
const chosen = [...(GATE_PLANT === "linger" ? [["lib/linger_plant.mjs", [], false]] : []), ...GATE.filter(([script, args]) => why ? why.has(nameOf(script)) : (!only || only.split(/[\s,]+/).some((w) => w && `${script} ${args.join(" ")}`.includes(w))))];

if (process.argv.includes("--list")) {
  for (const [script, args] of chosen) console.log(["scripts/" + script, ...args].join(" "));
  process.exit(0);
}

if (!chosen.length && !process.argv.includes("--serve")) { console.error(`--only ${only} matches no check on the gate`); process.exit(2); }
// The machine's queue for headless browsers, where it has one (WGP_QUEUE, or where the machine these checks were
// written on keeps it): browser checks go through it. Without one, the gate runs them itself, one at a time, as
// it runs every check.
const QUEUED = QUEUE !== null;
if (chosen.some((c) => c[2]) && !QUEUED) console.log("No queue on this machine: the browser checks run here, one at a time.");
const LOGS = process.env.WGP_GATE_LOGS || fs.mkdtempSync(path.join(os.tmpdir(), "wgp-gate-"));
fs.mkdirSync(LOGS, { recursive: true });

// The clock that notices a sleep: a tick that arrives far too late means nothing was running.
const TICK = 2000;
let lastTick = Date.now(), sleptNow = 0;
setInterval(() => {
  const now = Date.now(), gap = now - lastTick - TICK;
  lastTick = now;
  if (gap > 15000) sleptNow += gap;
}, TICK).unref();

const secs = (ms) => `${Math.round(ms / 1000)} s`;

// ── the gate's own server ───────────────────────────────────────────────────────────────────
// Made here unless one is handed in: a card (WGP_GATE_CARD, from `--serve`) whose server answers.
async function handedIn() {
  const file = process.env.WGP_GATE_CARD;
  if (!file || !fs.existsSync(file)) return null;
  try {
    const card = JSON.parse(fs.readFileSync(file, "utf8"));
    const res = await fetch(`${card.origin}/login`, { redirect: "manual" });
    return res.status < 500 ? { env: { WGP_BASE: card.origin, WGP_GATE_CARD: file }, card, stop: async () => {}, kept: true } : null;
  } catch { return null; }
}
let gateDb = null;
const serverEnv = () => (gateDb ? gateDb.env : {});
async function needServer() {
  if (gateDb) return gateDb;
  gateDb = await handedIn();
  if (gateDb) { console.log(`The gate's server: ${gateDb.card.origin}, handed in (WGP_GATE_CARD); it is left running.`); return gateDb; }
  const { makeGateDb } = await import("./lib/gate_db.mjs");
  gateDb = await makeGateDb({ port: Number(arg("--port")) || null, say: (line) => console.log(line) });
  return gateDb;
}

if (process.argv.includes("--serve")) {
  const made = await needServer();
  console.log(`\nKept up until this is stopped (Ctrl-C, or a TERM to pid ${process.pid}). To run a check against it:\n`
    + `  WGP_BASE=${made.env.WGP_BASE} WGP_GATE_CARD=${made.env.WGP_GATE_CARD} <the queue> -- node scripts/<check>\n`
    + `  WGP_GATE_CARD=${made.env.WGP_GATE_CARD} node scripts/gate.mjs --only <words>`);
  await new Promise(() => {});
}

const handed = [];
// The check running now: ended with the gate, however the gate ends (a check is started in a process group of its own,
// so nothing else ends it: 21 Nov, a gate that stopped on its own error left its check running).
let running = null;
process.on("exit", () => { if (running) { try { process.kill(-running.pid, "SIGKILL"); } catch { /* gone */ } } });
async function runOne([script, listed, browser]) {
  const label = [script, ...listed].join(" ");
  const args = [];
  for (const a of listed) {
    if (a !== FREE) { args.push(a); continue; }
    const port = await freePort({ avoid: handed.slice(-20) });
    handed.push(port);
    args.push(String(port));
  }
  return new Promise((resolve) => {
    const node = [process.execPath, path.join("scripts", script), ...args];
    const cmd = browser && QUEUED
      ? ["python3", QUEUE, "run", "--kind", "parallel", "--who", who, "--label", `wegoplace ${label}`, "--", ...node]
      : node;
    // Named without the leading "../" of a check in checks/, which made its log a hidden file (".._checks_…").
    const logFile = path.join(LOGS, label.replace(/^\.\.\//, "").replace(/[^\w.-]+/g, "_") + ".log");
    const log = fs.openSync(logFile, "w");
    if (args.join(" ") !== listed.join(" ")) fs.writeSync(log, `gate: run as ${[script, ...args].join(" ")}\n`);
    const t0 = Date.now();
    sleptNow = 0;
    const child = spawn(cmd[0], cmd.slice(1), { cwd: REPO, env: { ...OUTER, ...serverEnv(), WGP_GATE: "1" }, stdio: ["ignore", log, log], detached: true });
    running = child;
    let ended = "";
    const stop = (signal) => { try { process.kill(-child.pid, signal); } catch { /* gone */ } };
    let wrote = { size: 0, at: Date.now() };
    const lastLine = () => fs.readFileSync(logFile, "utf8").slice(-8192).trimEnd().split("\n").reverse()
      .find((l) => l.trim() && !/^\[gpu /.test(l)) || "";
    const watch = setInterval(() => {
      const size = fs.fstatSync(log).size;
      if (size !== wrote.size) wrote = { size, at: Date.now() };
      else if (!ended && Date.now() - wrote.at > LINGER_S * 1000) {
        const last = lastLine().trim();
        if (END_LINE.test(last)) {
          ended = `finished but didn't exit: left something open (nothing written for ${LINGER_S} s after "${last.slice(0, 60)}"): stopped`;
          stop("SIGTERM");
          setTimeout(() => stop("SIGKILL"), 15000).unref();
        }
      }
      if (!ended && Date.now() - t0 - sleptNow > CEILING_S * 1000) {
        ended = `still running after ${secs(Date.now() - t0 - sleptNow)} (ceiling WGP_GATE_CEILING_S=${CEILING_S}): stopped`;
        stop("SIGTERM");
        setTimeout(() => stop("SIGKILL"), 15000).unref();
      }
    }, 1000);
    child.on("error", (e) => { ended = ended || `could not start: ${e.message}`; });
    child.on("close", (code, signal) => {
      running = null;
      clearInterval(watch);
      fs.closeSync(log);
      const text = fs.readFileSync(logFile, "utf8");
      const lines = text.trimEnd().split("\n");
      // What the check itself said last: its ceiling line if the launcher ended it, else its tally.
      // (Only on the launcher's own exit code: its test quotes both ceiling lines while passing.)
      const said = (code === CEILING_EXIT && lines.find((l) => /DEVTOOLS CALL NEVER ANSWERED|HARNESS STILL RUNNING/.test(l)))
        || [...lines].reverse().find((l) => /\d+\s*\/\s*\d+|passed|failed|FATAL|ERROR|THREW/i.test(l) && !/^\[gpu /.test(l)) || "";
      resolve({ label, ok: code === 0 && !ended, code: ended || (signal ? `signal ${signal}` : `exit ${code}`),
        ms: Date.now() - t0, slept: sleptNow, said: said.trim().slice(0, 150), logFile });
    });
  });
}

const results = [];
if (chosen.some((c) => c[3] === "trip")) await needServer();
// THE TRIP'S ROWS ARE THE SAME AFTER A CHECK AS BEFORE IT (scripts/lib/gate_db.mjs, tripRows):
// a check that drives the trip removes only what it made and leaves nothing behind. Read
// around each such check, so the line that fails is the check that did it.
const { tripRows, rowsDiff } = gateDb ? await import("./lib/gate_db.mjs") : {};
let rowsNow = gateDb ? tripRows(gateDb.card) : null;
// A server named by the caller is not this gate's: no check is given it, nor a card when no
// check here drives the gate's server.
const OUTER = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["WGP_BASE", "WGP_GATE_CARD"].includes(name)));
console.log(`\nThe gate: ${chosen.length} checks${gateDb ? ` against ${gateDb.env.WGP_BASE}` : ""}, one at a time. Logs in ${LOGS}\n`);
for (const check of chosen) {
  let r = await runOne(check);
  if (!r.ok && r.slept) {
    console.log(`  ..    ${r.label}: ${r.code}, but the machine slept ${secs(r.slept)} during it. Running it once more.`);
    r = { ...(await runOne(check)), again: true };
  }
  if (rowsNow && check[3] === "trip") {
    const after = tripRows(gateDb.card);
    r.rows = rowsDiff(rowsNow, after);
    if (r.rows.length) { r.ok = false; r.code = `${r.code}, the trip's rows changed`; }
    rowsNow = after;
  }
  results.push(r);
  console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.label.padEnd(38)} ${r.code.padEnd(8)} ${secs(r.ms).padStart(6)}`
    + `${r.slept ? `  (the machine slept ${secs(r.slept)})` : ""}${r.again ? "  (second run)" : ""}${r.said ? `  ${r.said}` : ""}`);
  for (const line of r.rows || []) console.log(`          THE TRIP'S ROWS: ${line}`);
}

let rewritten = [];
try {
  rewritten = execFileSync("git", ["status", "--short", "--", "docs"], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
} catch { /* not a git checkout: nothing to say */ }
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} green.`);
for (const r of failed) console.log(`  FAILED  ${r.label}: ${r.code}. Log: ${r.logFile}${(r.rows || []).length ? `\n          ${r.rows.join("; ")}` : ""}`);
if (rewritten.length) console.log(`\n${rewritten.length} tracked file${rewritten.length === 1 ? "" : "s"} under docs/ rewritten by the checks. Put them back: git checkout -- docs`);
if (gateDb && !gateDb.kept) await gateDb.stop();
process.exit(failed.length ? 1 : 0);
