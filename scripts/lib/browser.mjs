// THE ONLY FILE THAT STARTS A BROWSER. Every harness gets its browser from launchChrome() and its
// server address from baseUrl(); scripts/test-browser-launcher.mjs fails if any other file can.
//
// WHY. The harnesses used to spawn /Applications/Google Chrome.app themselves. A headless copy of
// that app registers with macOS under the owner's own Chrome's bundle id, as a background app, and
// on 4 Nov 2026 he could not open Chrome at all while checks ran. So:
//
//   * The browser is Chrome for Testing, a separate app with its own bundle id, at one pinned
//     version, installed by scripts/install-check-chrome.mjs under ~/.local/share/chrome-for-testing
//     (on a Mac, the same install other projects' checks on that machine use). It is pinned for
//     each platform Google builds it for, by the zip's SHA-256 (CHROME_BUILDS). Nothing a caller or
//     the environment passes can name another: there is no path option and no env override. If
//     it isn't there, or isn't what it should be, the launch refuses. It never falls back.
//   * Always headless, always --mute-audio. (--mute-audio does not silence speechSynthesis, which
//     macOS speaks outside Chrome; the test fails if client code starts using it, so that whoever
//     adds speech silences it here first.)
//   * The debugging port is never chosen: --remote-debugging-port=0, and the port Chrome really
//     bound is read from DevToolsActivePort inside a profile directory minted for this launch.
//     A harness can only ever drive the browser it started (a guessed port once drove another
//     harness's browser).
//   * It stops only what it started. close() ends this launch's process and removes this launch's
//     profile. If the harness dies instead (a throw, Ctrl-C, SIGTERM, even SIGKILL) the browser
//     still goes: an exit handler, signal handlers, and a small watcher process that outlives a
//     hard kill. No harness pkills by name; with two lanes that killed the other lane's browser.
//   * On a machine with a queue for headless browsers (gpu.py: WGP_QUEUE, or where the machine
//     these checks were written on keeps it), launches go through it, which is how that machine
//     keeps them from piling up; a launch outside it refuses and prints the command. On a machine
//     without one, a harness launches its own browser (the gate runs them one at a time).
//   * Never beside another lane's landing. On the machine these checks were written on, a lane that lands holds
//     a lock (a folder with a `who` file that starts with its session's name) and runs its gate under it; a browser
//     started beside that gate can put a false red in what it's reading, or a stutter in a film being taken.
//     So a launch refuses, with exit 75 and one line naming the holder, while the lock is held by anyone but
//     the caller: WGP_LANE names the caller (gate.mjs sets it from --who; the machine's browser wrapper from its
//     session); no WGP_LANE, no launch while any lock is held. WGP_LOCK can name another lock; it can't take
//     that one away (20 Nov: a gate run started outside the wrapper, with an empty list, ran beside two).
//   * Nothing waits for ever. Every DevTools call a harness sends, over whatever socket code it
//     has, gets a ceiling here (WGP_CALL_CEILING_S, 120 s), and the whole run gets one too
//     (WGP_RUN_CEILING_S, 900 s). Past either, the harness ends with exit 124 and a line naming
//     the call that never answered, instead of holding a queue slot in silence. A machine that
//     slept is said to have slept.
//
// THE BASE URL. One address for every harness: WGP_BASE in the environment, or --base=<url>.
// There is no default. Each lane has its own dev server and its own database (the app's folder
// 8788, the server lane 8791, the client lane 8792), harnesses write fixtures, and a default
// would point a lane's harness at someone else's database. Loopback only, so nothing here can
// be aimed at the live site.
//
// Plain ES module with no top-level await, so the CommonJS harnesses can require() it.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const CHROME_VERSION = "156.0.8078.80";
export const CHROME_BUNDLE = "com.google.chrome.for.testing";
export const CHROME_HOME = path.join(os.homedir(), ".local/share/chrome-for-testing");
// Google's builds of the pinned version, by platform: its download's name, and the zip's SHA-256 as first
// downloaded from Google's bucket (mac-arm64 on 4 Nov 2026; the others on 16 Nov 2026). Google doesn't sign
// Chrome for Testing for us to check, so the hash is what ties an install to Google's zip.
export const CHROME_BUILDS = Object.freeze({
  "darwin-arm64": { name: "mac-arm64", sha256: "8bc590d1b1acac042a000234c768f31830f25a3983a83ed5e067114c87c4cad1" },
  "darwin-x64": { name: "mac-x64", sha256: "672b79dc79fdf28bb2ec9787b7fa33810c2b3cfd946a0fb4d3b72775f4e6fd9a" },
  "linux-x64": { name: "linux64", sha256: "b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7" },
  "win32-x64": { name: "win64", sha256: "16edb57d6107bf1c48a7c149b8d78b155fe614410093796dd72441fd6640540f" },
});
export const CHROME_BUILD = CHROME_BUILDS[`${process.platform}-${process.arch}`] ?? null;
const CHROME_FOLDER = CHROME_BUILD ? path.join(CHROME_HOME, CHROME_VERSION, `chrome-${CHROME_BUILD.name}`) : null;
// A Mac's is an app bundle (its id and version are in it); elsewhere the folder, with the installer's stamp.
export const CHROME_APP = !CHROME_BUILD ? null
  : process.platform === "darwin" ? path.join(CHROME_FOLDER, "Google Chrome for Testing.app") : CHROME_FOLDER;
// What the installer writes into a Linux or Windows install, whose files don't say their version: the
// version and the hash of the zip it was checked against.
export const CHROME_STAMP = ".wegoplace-chrome-for-testing";
export const stampFor = (build) => `${CHROME_VERSION} ${build.sha256}\n`;

const INSTALL = "node scripts/install-check-chrome.mjs";
// Where the machine these checks were written on keeps its queue, under the account's REAL home: the system's
// record of it (os.userInfo), never $HOME, so no environment can make a machine with a queue look like one without.
const HOME_QUEUE = path.join(os.userInfo().homedir, "Documents/GitHub/imaginative-prompting/pipelines/lyric-video/tools/gpu.py");
/**
 * This machine's queue for headless browsers, or null when it has none: its own (above), else the one WGP_QUEUE
 * names when that file is there. The environment can name a queue; it can't take one away.
 */
export function queueOf({ home = HOME_QUEUE, named = process.env.WGP_QUEUE } = {}) {
  if (fs.existsSync(home)) return home;
  if (named && fs.existsSync(named)) return named;
  return null;
}
export const QUEUE_PATH = queueOf() ?? HOME_QUEUE;
/** Whether this machine has a queue for headless browsers. */
export const queueHere = () => queueOf() !== null;
const QUEUE = `python3 ${QUEUE_PATH} run --kind parallel --who <session> --label <what> -- node scripts/<harness> (sandbox off)`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── whose landing it is ───────────────────────────────────────────────────────────────────

// Where the machine these checks were written on keeps its landing lock, under the account's real home (as its queue).
const HOME_LOCK = path.join(os.userInfo().homedir, "Documents/GitHub/imaginative-prompting/16-wegoplace/lanes/landing.lock/who");
/**
 * Why a browser may not start now, or null: a lock held by anyone but `lane`. `files` are the lock's `who` files to
 * read (this machine's, and WGP_LOCK's); a lock folder whose `who` can't be read is held by someone unnamed.
 */
export function lockRefusal({ files = [HOME_LOCK, process.env.WGP_LOCK].filter(Boolean), lane = process.env.WGP_LANE || "" } = {}) {
  for (const file of files) {
    let who = null;
    try { who = fs.readFileSync(file, "utf8").trim(); }
    catch { if (!fs.existsSync(path.dirname(file))) continue; who = ""; }
    // The holder is named first; a session's name may itself have spaces ("wegoplace director 14:57 …").
    if (lane && (who === lane || who.startsWith(lane + " "))) continue;
    return `REFUSED: the landing lock is held by ${who ? `"${who}"` : "someone unnamed"}${lane ? `, not ${lane}` : " and no WGP_LANE names the caller"}. No browser beside a landing: code goes on.`;
  }
  return null;
}
/** Exits 75 with one line when lockRefusal() says no. launchChrome() calls it last, just before a browser would start. */
export function refuseUnderAnothersLock() {
  const why = lockRefusal();
  if (why) { process.stderr.write(why + "\n"); process.exit(75); }
}

// ── which browser ─────────────────────────────────────────────────────────────────────────

const plist = (app, key) => execFileSync("/usr/bin/plutil",
  ["-extract", key, "raw", "-o", "-", path.join(app, "Contents/Info.plist")], { encoding: "utf8" }).trim();

const confirmed = new Set();

/** The executable inside `app`, once `app` is shown to be the pinned Chrome for Testing. Anything else throws. */
export function checkChromeAt(app) {
  if (process.platform !== "darwin") return checkFolderAt(app, CHROME_BUILD, process.platform === "win32" ? "chrome.exe" : "chrome");
  const executable = path.join(app, "Contents/MacOS/Google Chrome for Testing");
  if (confirmed.has(app)) return executable;
  if (!fs.existsSync(executable)) {
    throw new Error(`Chrome for Testing ${CHROME_VERSION} isn't installed at ${app}. `
      + `Harnesses never use the owner's Chrome and never fall back. Install it: ${INSTALL}`);
  }
  const bundle = plist(app, "CFBundleIdentifier");
  if (bundle !== CHROME_BUNDLE) {
    throw new Error(`${app} is ${bundle}, not ${CHROME_BUNDLE}. Harnesses only run on Chrome for Testing. Install it: ${INSTALL}`);
  }
  const version = plist(app, "CFBundleShortVersionString");
  if (version !== CHROME_VERSION) {
    throw new Error(`${app} is Chrome for Testing ${version}, not the pinned ${CHROME_VERSION}. Install it: ${INSTALL}`);
  }
  confirmed.add(app);
  return executable;
}

/**
 * A Linux or Windows install (a folder): its executable is there, and the installer's stamp says it is the
 * pinned version, checked against this build's hash. Anything else throws.
 */
export function checkFolderAt(folder, build, name) {
  if (!build) throw new Error(`Chrome for Testing has no pinned build for ${process.platform}-${process.arch} here (CHROME_BUILDS).`);
  const executable = path.join(folder, name);
  if (confirmed.has(folder)) return executable;
  if (!fs.existsSync(executable)) {
    throw new Error(`Chrome for Testing ${CHROME_VERSION} isn't installed at ${folder}. Harnesses never use your own browser and never fall back. Install it: ${INSTALL}`);
  }
  let stamp = "";
  try { stamp = fs.readFileSync(path.join(folder, CHROME_STAMP), "utf8"); } catch { /* none */ }
  if (stamp !== stampFor(build)) {
    throw new Error(`${folder} isn't the pinned Chrome for Testing ${CHROME_VERSION} (its stamp says ${JSON.stringify(stamp.trim()) || "nothing"}). Install it: ${INSTALL}`);
  }
  confirmed.add(folder);
  return executable;
}

/** The one executable a harness may run. Takes nothing: neither a caller nor the environment chooses it. */
export function chromeExecutable() {
  if (!CHROME_APP) throw new Error(`Chrome for Testing has no pinned build for ${process.platform}-${process.arch} here (CHROME_BUILDS).`);
  return checkChromeAt(CHROME_APP);
}

// ── which server ──────────────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The dev server every harness in this run drives, e.g. "http://127.0.0.1:8792". Required; loopback only. */
export function baseUrl({ argv = process.argv, env = process.env } = {}) {
  const flag = argv.find((a) => a.startsWith("--base="));
  const given = flag ? flag.slice("--base=".length) : env.WGP_BASE;
  if (!given) {
    throw new Error("No base URL. Say which dev server to drive: WGP_BASE=http://127.0.0.1:<port> or --base=http://127.0.0.1:<port> "
      + "(the app's folder 8788, the server lane 8791, the client lane 8792). There is no default: "
      + "each lane has its own server and database, and a harness must never write to another's.");
  }
  let url;
  try { url = new URL(given); } catch { throw new Error(`The base URL ${JSON.stringify(given)} isn't a URL.`); }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
    throw new Error(`The base URL ${given} isn't a dev server on this computer (http://127.0.0.1, http://localhost or http://[::1]). `
      + "Harnesses write fixtures and never run against anything else.");
  }
  if (!url.port) throw new Error(`The base URL ${given} has no port.`);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
    throw new Error(`The base URL ${given} must be an origin only: http://${url.host}`);
  }
  return url.origin;
}

// A CHECK WITH A SERVER OF ITS OWN. Some checks do what no shared database should see: delete
// an account for good, fill a trip's storage, age a row. They start their own server
// (checks/lib/server.mjs: an empty database under .wrangler/check/, removed afterwards) and
// drive that one. Two things keep them inside the rules above:
//   * the port is found, never written down: freeLoopbackPort() finds one that is free now,
//     with the one a thousand above it (wrangler's inspector) free too;
//   * the server is named here, once: ownServer(origin) makes it THIS process's base URL,
//     whatever the caller's WGP_BASE said, so every helper that reads baseUrl() drives the
//     check's own server and none can write to the lane's. Call it before importing anything
//     that reads baseUrl() when it loads (scripts/lib/standalone_cdp.mjs does).

const portFree = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once("error", () => resolve(false));
  probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => probe.close(() => resolve(true)));
});

/**
 * A loopback port that is free now, and whose port + 1000 is free too.
 *
 * Picked at random between 20000 and 60000 and then tried, not asked of the system: the
 * system hands its ports out in order from a range that ends at 65535, so while its counter
 * sits in the top thousand every port it offers has no "a thousand above" at all, forty times
 * in a row (it happened: 14 Nov, a check that could not start).
 */
export async function freeLoopbackPort() {
  for (let tries = 0; tries < 40; tries++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    if (await portFree(port) && await portFree(port + 1000)) return port;
  }
  throw new Error("No free loopback port with the one a thousand above it free as well, in 40 tries.");
}

/** Makes a server this check started the base URL of this process. Loopback only, like baseUrl(). */
export function ownServer(origin) {
  const checked = baseUrl({ argv: [], env: { WGP_BASE: String(origin) } });
  process.env.WGP_BASE = checked;
  return checked;
}

// ── launching ─────────────────────────────────────────────────────────────────────────────

// What the launcher decides. A caller passing one of these is asking for a different browser
// setup than the one every harness shares, so it's refused rather than merged.
const OWNED = /^--(headless|remote-debugging-(port|pipe|address)|user-data-dir|no-sandbox|host-resolver-rules|host-rules|proxy-server|enable-features)(=|$)/;

// QUIET. A browser on a fresh profile calls its maker's servers at every start, for things no
// check uses: sign-in state, component and field-trial downloads, safe-browsing lists, network
// time, form-field lookups, search preconnects, crash and reliability reports. A gate starts
// dozens of browsers an hour, and a network watching for odd traffic sees every one. With what
// follows, the harness browser talks to this computer and to nothing else. Three layers:
//
//   QUIET_FLAGS     the switches that turn whole background subsystems off.
//   QUIET_FEATURES  callers those switches leave running, each turned off by its feature name
//                   (measured: each one's request is gone from the browser's net log).
//   QUIET_RESOLVER  the wall. Every host name but this computer's fails to resolve, inside the
//                   browser, before any lookup or connection. Two callers have no switch (the
//                   signed-in-accounts list and one on-demand component check): they still ask,
//                   and the ask ends at the wall. So does anything a later browser version adds.
//
// scripts/test-browser-launcher.mjs holds all three: it fails if one is missing from the
// command line, and its --browser part leaves the browser up for a minute on a page of the app
// and fails on any socket of its process tree, or any address in its own net log, that isn't
// this computer. None of this changes what a page of the app does: the app asks for nothing
// outside its own origin, and no switch here changes how the browser draws or takes input.
export const QUIET_FLAGS = Object.freeze([
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-client-side-phishing-detection",
  "--disable-default-apps",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-pings",
  "--disable-domain-reliability",
  "--disable-breakpad",
]);
// NOT here, on purpose: --disable-field-trial-config. It is on most lists of quiet switches,
// but it sends nothing anywhere: it turns off the set of features this build of the browser
// runs with, which makes it a different browser from the one the checks were written against
// (measured: Input.synthesizeScrollGesture then answers "Position out of bounds" for a point
// inside the page, and three scroll checks fail). The measurement is the same without it.
export const QUIET_FEATURES = Object.freeze([
  "NetworkTimeServiceQuerying",          // clients2.google.com/time/1/current
  "AutofillServerCommunication",         // content-autofill.googleapis.com, on any page with a form
  "AimEnabled",                          // www.google.com/async/folae (AI-mode eligibility)
  "AimServerRequestOnStartupEnabled",    // the same request, at startup
  "PreconnectToSearch",                  // a connection to www.google.com kept warm
]);
// www.localhost is this machine too, named so: the site's second address in check:www (a site
// served at www. as well as without it). It is mapped to 127.0.0.1 before the wall, so it never
// reaches a resolver either.
export const QUIET_RESOLVER = "MAP www.localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]";

/**
 * The whole command line of the harness browser, after the executable. Pure, so the test can
 * read it without starting anything. A caller's `--disable-features=` is MERGED with
 * QUIET_FEATURES into one switch: the browser reads only the last one it is given, so a
 * caller's would otherwise silently turn the quiet ones back on.
 */
export function chromeArgs(profile, args = []) {
  const features = new Set(QUIET_FEATURES);
  const rest = [];
  for (const a of args) {
    const m = /^--disable-features=(.*)$/.exec(a);
    if (!m) { rest.push(a); continue; }
    for (const f of m[1].split(",")) if (f.trim()) features.add(f.trim());
  }
  return [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--mute-audio", "--no-first-run", "--no-default-browser-check",
    ...QUIET_FLAGS,
    `--host-resolver-rules=${QUIET_RESOLVER}`,
    `--disable-features=${[...features].join(",")}`,
    ...rest,
  ];
}

const live = new Set();
let hooked = false;
// close(): how long a browser has to exit after SIGTERM, then after SIGKILL. A SIGKILL is not
// refused, but on a loaded machine the exit can take seconds to land.
const TERM_WAIT_MS = 3000;
const KILL_WAIT_MS = 10000;

function hook() {
  if (hooked) return;
  hooked = true;
  const killAll = () => { for (const b of live) b.killSync(); };
  process.on("exit", killAll);
  for (const [name, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) {
    process.on(name, () => { killAll(); process.exit(128 + n); });
  }
}

// Chrome keeps a unix socket inside the profile, and those paths cap near 104 characters: a
// profile under a long temp directory makes it abort at startup. Fall back to /tmp when the
// system's temp directory is that deep.
function profileRoot() {
  const root = fs.realpathSync(os.tmpdir());
  return path.join(root, "wgp-cft-XXXXXX", "SingletonSocket").length > 96 ? "/tmp" : root;
}

function removeDir(dir) {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Chrome still writing; try again */ }
    if (!fs.existsSync(dir)) return true;
    execFileSync("/bin/sleep", ["0.2"]);
  }
  return !fs.existsSync(dir);
}

/** True when a `gpu.py run` is among this process's parents. Read from the process table, not
 * from the environment: the queue's parallel lane sets no variable, and a variable is one any
 * caller could set. In the command sandbox other processes can't be seen, so this is false there. */
function underQueue() {
  let pid = process.ppid;
  for (let hop = 0; hop < 16 && pid > 1; hop++) {
    let row;
    try {
      row = execFileSync("/bin/ps", ["-o", "ppid=,args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch { return false; }
    const m = /^(\d+)\s+(.*)$/s.exec(row);
    if (!m) return false;
    if (/(^|[\s/])gpu\.py\s+run(\s|$)/.test(m[2])) return true;
    pid = Number(m[1]);
  }
  return false;
}

// ── ceilings ──────────────────────────────────────────────────────────────────────────────
// The harnesses talk DevTools over the global WebSocket, each with its own few lines of socket
// code, and none of that code gives a call a deadline: a call Chrome never answers (a
// screenshot of a page that went away, an evaluate whose promise never settles) parks the
// harness until somebody notices. So the deadline lives here, under all of them: send() is
// watched for {id, method}, the answer with that id clears it, and a timer looks for a call
// that has waited too long.
const CALL_CEILING_S = Number(process.env.WGP_CALL_CEILING_S) || 120;
const RUN_CEILING_S = Number(process.env.WGP_RUN_CEILING_S) || 900;
export const CEILING_EXIT = 124;
let watching = false;

function watchCalls() {
  if (watching || typeof globalThis.WebSocket !== "function") return;
  watching = true;
  const sockets = new Map();      // socket -> Map(id -> { method, at })
  const recent = [];              // the last few calls sent, for the run ceiling's message
  const started = Date.now();
  let slept = 0;                  // ms the clock jumped while this process was not running
  const send = globalThis.WebSocket.prototype.send;
  globalThis.WebSocket.prototype.send = function watchedSend(data) {
    try {
      if (typeof data === "string" && data.charCodeAt(0) === 123) {
        const m = JSON.parse(data);
        if (m && Number.isInteger(m.id) && typeof m.method === "string") {
          let calls = sockets.get(this);
          if (!calls) {
            calls = new Map();
            sockets.set(this, calls);
            // Chrome writes "id" first in an answer; an event has no id. Read off the front of
            // the frame so a 10 MB screenshot is never parsed twice.
            this.addEventListener("message", (ev) => {
              const hit = typeof ev.data === "string" ? /^\{"id":(\d+)/.exec(ev.data.slice(0, 32)) : null;
              if (hit) calls.delete(Number(hit[1]));
            });
            this.addEventListener("close", () => sockets.delete(this));
          }
          calls.set(m.id, { method: m.method, at: Date.now() });
          recent.push(m.method);
          if (recent.length > 6) recent.shift();
        }
      }
    } catch { /* not a DevTools call; nothing to watch */ }
    return send.call(this, data);
  };

  const TICK = 2000;
  let last = Date.now();
  const age = (ms) => `${Math.round(ms / 1000)} s`;
  const end = (line) => {
    const nap = slept ? ` The machine slept for ${age(slept)} of this run; that time is not counted.` : "";
    process.stderr.write(`\n${line}${nap}\nThe harness ends here (exit ${CEILING_EXIT}); its browser and profile are closed.\n`);
    process.exit(CEILING_EXIT);
  };
  const timer = setInterval(() => {
    const now = Date.now();
    // A tick that arrives far too late means nothing here was running: the machine slept (or
    // the process was stopped). Don't count that time against a call or the run.
    const gap = now - last - TICK;
    last = now;
    if (gap > 15000) {
      slept += gap;
      for (const calls of sockets.values()) for (const c of calls.values()) c.at += gap;
    }
    const waiting = [];
    for (const calls of sockets.values()) for (const c of calls.values()) waiting.push(c);
    waiting.sort((a, b) => a.at - b.at);
    const oldest = waiting[0];
    if (oldest && now - oldest.at > CALL_CEILING_S * 1000) {
      const others = waiting.slice(1, 4).map((c) => `${c.method} (${age(now - c.at)})`).join(", ");
      end(`DEVTOOLS CALL NEVER ANSWERED: ${oldest.method}, sent ${age(now - oldest.at)} ago (ceiling WGP_CALL_CEILING_S=${CALL_CEILING_S}).`
        + (others ? ` Also waiting: ${others}.` : ""));
    }
    if (now - started - slept > RUN_CEILING_S * 1000) {
      end(`HARNESS STILL RUNNING after ${age(now - started - slept)} (ceiling WGP_RUN_CEILING_S=${RUN_CEILING_S}). `
        + (oldest ? `Waiting on ${oldest.method} for ${age(now - oldest.at)}.` : `No DevTools call is waiting; the last ones sent: ${recent.join(", ") || "none"}.`));
    }
  }, TICK);
  timer.unref();
}

/**
 * Start the harness browser. `args` are extra Chrome flags and an optional first URL
 * ("about:blank", "--app=<url>", "--window-size=390,844"); the launcher adds headless, the
 * debugging port, the profile and the mute itself and refuses to have them overridden.
 *
 * Returns { port, origin, wsUrl, pid, profile, pageTarget(), exited(), stderrTail(), close(), killSync() }:
 *   origin   http://127.0.0.1:<port>, for /json/list, /json/version, /json/new
 *   wsUrl    the browser's own websocket, as Chrome wrote it
 *   close()  ends this browser and removes its profile; resolves once neither is left. A browser
 *            that never exits makes it throw, its profile kept for the exit handler and the watcher
 */
export async function launchChrome(options = {}) {
  const { args = [], ...unknown } = options;
  if (Object.keys(unknown).length) {
    throw new Error(`launchChrome takes { args } only, not ${Object.keys(unknown).join(", ")}. `
      + "The browser, its profile and its port aren't the caller's to choose.");
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new Error("launchChrome: args must be an array of strings");
  const taken = args.filter((a) => OWNED.test(a));
  if (taken.length) throw new Error(`launchChrome sets ${taken.join(", ")} itself; take ${taken.length > 1 ? "them" : "it"} out of args.`);
  if (queueHere() && !underQueue()) {
    throw new Error(`Browser checks run through the machine's queue, one at a time per session: ${QUEUE}`);
  }
  // Last of the refusals, just before a browser would start: what a caller asked for wrongly is said first.
  refuseUnderAnothersLock();
  const executable = chromeExecutable();
  watchCalls();

  const profile = fs.mkdtempSync(path.join(profileRoot(), "wgp-cft-"));
  const proc = spawn(executable, chromeArgs(profile, args), { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => { err = (err + String(d)).slice(-4000); });
  let gone = false;
  proc.on("exit", () => { gone = true; });

  // The watcher: if this process is killed outright (no handler runs on SIGKILL), it ends the
  // browser of THIS profile and removes the profile. It checks that it can see this process
  // before trusting "gone", so a sandbox that hides processes can't make it kill a live run.
  const watcher = spawn("/bin/sh", ["-c",
    'kill -0 "$1" 2>/dev/null || exit 0; '
    + 'while kill -0 "$1" 2>/dev/null; do sleep 1; done; '
    + 'pkill -9 -f "user-data-dir=$2" 2>/dev/null; sleep 1; rm -rf "$2"',
    "wgp-browser-watcher", String(process.pid), profile], { detached: true, stdio: "ignore" });
  watcher.unref();

  const browser = {
    pid: proc.pid, profile, port: 0, origin: "", wsUrl: "",
    exited: () => gone,
    /** The first page target ({ id, webSocketDebuggerUrl, … } as /json/list gives it). */
    async pageTarget() {
      // Bounded twice over: each ask gives up after 2 s (a browser that accepts the connection
      // and never answers must not hold a harness for fetch's own five minutes), and the whole
      // wait after 20 s.
      const end = Date.now() + 20000;
      while (Date.now() < end && !gone) {
        try {
          const list = await (await fetch(`${browser.origin}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
          const target = list.find((t) => t.type === "page");
          if (target) return target;
        } catch { /* the HTTP endpoint isn't up yet, or didn't answer in time */ }
        await sleep(100);
      }
      throw new Error("the harness browser has no page target:\n" + browser.stderrTail());
    },
    stderrTail: () => err.split("\n").slice(-8).join("\n"),
    killSync() {
      live.delete(browser);
      try { proc.kill("SIGKILL"); } catch { /* gone */ }
      // The profile is the watcher's to remove here: Chrome is still exiting, and this runs
      // inside an exit handler that can't wait for it.
    },
    async close() {
      // Nothing that would end this browser is let go until it has exited: not its profile, not
      // the watcher, not the exit handler's hold on it. A browser still exiting when they go is
      // one nothing ends (16 Nov: a Chrome for Testing outlived its removed profile by hours; close()
      // then removed the profile and the watcher before looking at whether the browser had exited,
      // and the harness swallowed its throw).
      const waitGone = async (ms) => { for (const end = Date.now() + ms; !gone && Date.now() < end;) await sleep(100); };
      if (!gone) {
        try { proc.kill("SIGTERM"); } catch { /* gone */ }
        await waitGone(TERM_WAIT_MS);
        if (!gone) { try { proc.kill("SIGKILL"); } catch { /* gone */ } await waitGone(KILL_WAIT_MS); }
      }
      if (!gone) {
        throw new Error(`the harness browser (pid ${proc.pid}) did not exit ${KILL_WAIT_MS / 1000} s after SIGKILL; `
          + `its profile ${profile} stays, and the exit handler and the watcher end it when this harness exits`);
      }
      live.delete(browser);
      const removed = removeDir(profile);
      try { watcher.kill("SIGKILL"); } catch { /* gone */ }
      if (!removed) throw new Error(`could not remove the harness browser's profile ${profile}`);
    },
  };
  live.add(browser);
  hook();

  // Chrome writes two lines: the port it bound, then the browser websocket's path. Both come
  // from a file only this launch's process could have written.
  const active = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 300 && !browser.wsUrl; i++) {
    await sleep(100);
    if (gone) break;
    try {
      const [p, wsPath] = fs.readFileSync(active, "utf8").split("\n");
      if (p && wsPath && wsPath.trim()) {
        browser.port = Number(p.trim());
        browser.origin = `http://127.0.0.1:${browser.port}`;
        browser.wsUrl = `ws://127.0.0.1:${browser.port}${wsPath.trim()}`;
      }
    } catch { /* not written yet */ }
  }
  if (!browser.wsUrl) {
    const why = gone
      ? `Chrome for Testing exited (${proc.exitCode ?? proc.signalCode}) before opening its debugging port. Browser launches need the command sandbox off.`
      : "Chrome for Testing never wrote DevToolsActivePort.";
    await browser.close().catch(() => {});
    throw new Error(`${why}\n${browser.stderrTail()}`);
  }
  return browser;
}

// ── Add photos as a phone does it (memories.js addPhotos: a tap opens the phone's own picker, what is chosen there
// opens the one Add photos sheet). A check taps the button with a user's gesture on ITS OWN session of a browser this
// launcher started, the file chooser is caught (Page.setInterceptFileChooserDialog) and answered with the check's files,
// which fires the input's change. scripts/lib/photo_picker.mjs re-exports it, with madePhoto() and cdpPage().
//
//   await pickPhotos({ send, on, open, files })
//     send(method, params)   the session's CDP send (standalone_cdp: cdpPage(cdp, S); checks/lib/chrome: page.send)
//     on(fn)                 the session's CDP events, answering the way to stop
//     open                   a JS expression for the button to tap (".me-fab" by default, the Photos screen's +)
//     files                  absolute paths on this machine
// It throws when nothing is there to tap, or no picker opened within `within` ms. It answers the picker's details.
export async function pickPhotos({ send, on, open = `document.querySelector(".me-fab")`, files, within = 15000 }) {
  await send("DOM.enable", {});
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  let off = null;
  const chosen = new Promise((ok) => { off = on((m) => { if (m.method === "Page.fileChooserOpened") ok(m.params); }); });
  try {
    const r = await send("Runtime.evaluate", {
      expression: `(() => { const n = ${open}; if (!n) return 0; n.click(); return 1; })()`,
      userGesture: true, returnByValue: true,
    });
    if (r.exceptionDetails || r.result?.value !== 1) throw new Error(`nothing to tap for Add photos: ${open}`);
    let timer = null;
    const c = await Promise.race([chosen, new Promise((_, no) => { timer = setTimeout(() => no(new Error(`Add photos opened no picker within ${within} ms`)), within); })]);
    clearTimeout(timer);
    await send("DOM.setFileInputFiles", { files, backendNodeId: c.backendNodeId });
    return c;
  } finally {
    if (off) off();
    await send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }
}
