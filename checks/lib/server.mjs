// A local server for a check: its own database, buckets, settings and log, and nothing of the
// developer's (.dev.vars is never read). The settings are wrangler.jsonc's own with the few
// changes a check asks for, written to a file under .wrangler/check/ and removed afterwards.
//
//   const server = await startServer({ name: "accounts", port: 8791, vars: { … }, secrets: { … } });
//   server.origin              http://localhost:<port>
//   server.sql("SELECT …")     rows, read or written in the server's own local database
//   server.sqlFile(path)       a .sql file, the way a migration is applied by hand
//   server.put(bucket, key, file)
//   server.has(bucket, key)
//   server.logMark(), await server.mailTo(address, mark)   the emails it "sent" (printed, never sent)
//   server.log()               everything the server has printed so far
//   await server.halt(), await server.start({ vars, secrets, main, limits })   the same database under other settings
//   server.configured            what wrangler.jsonc sets: { limits: { AUTH_LIMITER: 60, … } }
//   await server.stop()        stops the server this started (never any other) and removes its files; a server whose
//                              processes outlive the halt is said (its pid, how long) and its files are kept
//
// EVERY SERVER HAS A FOLDER OF ITS OWN: .wrangler/check/<name>-<pid>-<six letters>, made by mkdtemp, so no two servers
// ever share one, in one run or across runs. (27 Nov: named <name>-<pid> alone, a copy whose pid an earlier, stopped
// copy had had (the pids wrap) opened that copy's database and failed its seed with 409.) A folder named for this
// process's pid that this process didn't make is an earlier process's, left behind: it is removed before a server starts.
// Stopped by SIGINT, SIGTERM or SIGHUP (to the check, or to its process group), a check stops its servers, waits for
// their processes to be gone, and removes their folders before it exits.
//
// Everything that starts a server goes through the machine's queue (see README.md).

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "../parity/lib.mjs";
import { startFar } from "./far.mjs";
import { parseJsonc } from "../../tools/jsonc.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// EVERY SERVER A CHECK STARTS IS WRITTEN DOWN. It is spawned detached, leading its own process
// group, so a run stopped from outside (a stopped task, a closed terminal) leaves it running.
// Its pid, port and check go in a file of their own under $TMPDIR/wgp-server-checks/<this tree>/
// (and server.pid in its work folder) from its start until it stops; checks/lib/leftovers.mjs
// finds a leftover by that file and nothing else. A process list proves nothing here: both
// lanes' servers carry lanes/server/node_modules in their command lines. And the temp folder is
// shared by both lanes, so the records are kept apart by the tree that made them (its folder is
// named for this tree's path) and each record names its tree: a lane never sees, refuses on or
// stops another lane's server.
const TREE = createHash("sha256").update(ROOT).digest("hex").slice(0, 12);
export const PIDS = path.join(os.tmpdir(), "wgp-server-checks", TREE);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** The written-down servers: [{ file, pid, port, check, started, alive }]. */
export function recordedServers() {
  if (!fs.existsSync(PIDS)) return [];
  return fs.readdirSync(PIDS).filter((f) => f.endsWith(".json")).map((f) => {
    let r = {};
    try { r = JSON.parse(fs.readFileSync(path.join(PIDS, f), "utf8")); } catch { /* half written */ }
    return { file: path.join(PIDS, f), ...r, alive: Number.isInteger(r.pid) && alive(r.pid) };
  }).filter((r) => r.tree === ROOT);     // only this tree's: never another lane's
}

// THE RATES PROVIDER, STOOD IN FOR. The server asks a provider for exchange rates (src/api/fx.js)
// when a trip is read and its table is due, and when asked to refresh. A check never reaches
// the network for them: every server started here asks a stand-in on this machine, through
// FX_PROVIDER_URL (honoured only on a loopback address), which answers these fixed rates in the
// provider's own shape. So no check depends on the network, or on the day's numbers.
export const FIXED_RATES = {
  EUR: 0.92, GBP: 0.79, JPY: 151.4, CHF: 0.88, CAD: 1.37, AUD: 1.52, NZD: 1.66, CNY: 7.24, HKD: 7.81, SGD: 1.34,
  SEK: 10.6, NOK: 10.8, DKK: 6.87, PLN: 3.98, CZK: 23.1, HUF: 362, RON: 4.58, ISK: 138, TRY: 32.4, ILS: 3.71,
  INR: 83.4, THB: 36.2, VND: 25400, IDR: 15900, MYR: 4.71, PHP: 57.8, KRW: 1365, TWD: 32.3, MXN: 17.1, BRL: 5.12,
  ARS: 870, CLP: 945, COP: 3920, PEN: 3.72, BOB: 6.91, UYU: 39.2, ZAR: 18.6, MAD: 10.0, EGP: 47.3, KES: 131,
};
function startRates() {
  return new Promise((resolve, reject) => {
    const standin = http.createServer((req, res) => {
      standin.asked = (standin.asked ?? 0) + 1;
      const now = Math.floor(Date.now() / 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "success", base_code: "USD", time_last_update_unix: now, time_next_update_unix: now + 86400, rates: { USD: 1, ...FIXED_RATES } }));
    });
    standin.on("error", reject);
    standin.listen(0, "127.0.0.1", () => resolve(standin));
  });
}
export const WRANGLER = path.join(ROOT, "node_modules/.bin/wrangler");

// What checks/harness/folders.mjs plants (WGP_SERVER_PLANT, read only there): "no-wait" removes a stopped
// server's folder without waiting for its processes (so it is kept), "same-name" names the folder <name>-<pid> again,
// "keep-stale" leaves an earlier process's folder of this name and pid where it is, "first-only" stops one server of
// several on a signal.
const SERVER_PLANT = process.env.WGP_SERVER_PLANT || "";
/** A synchronous pause, for a signal handler that must not return before its work is done. */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** The folders this process made (its own servers', live or stopped). */
const madeHere = new Set();
/**
 * The servers of this process still up, each as its stop on a signal. ONE handler a signal for all of them, put before
 * any other (a handler after it may exit the process at once: the browser launcher's does), stops each in turn and
 * then exits: with a handler a server, the first to run exited before the others had stopped theirs.
 */
const onSignalStops = new Set();
let signalsHooked = false;
function hookSignals() {
  if (signalsHooked) return;
  signalsHooked = true;
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    process.prependListener(sig, () => {
      // No server up: whatever else listens decides, and with nothing else, the signal does what it would have.
      if (!onSignalStops.size) { if (process.listenerCount(sig) === 1) process.exit(code); return; }
      for (const stop of [...onSignalStops]) {
        try { stop(); } catch { /* the next one all the same */ }
        if (SERVER_PLANT === "first-only") break;
      }
      process.exit(code);
    });
  }
}
/**
 * Removes the folders under .wrangler/check of this name and this process's pid (<name>-<pid>, as they were named
 * before 27 Nov, and <name>-<pid>-<six letters>) that this process didn't make: an earlier process's with the same pid
 * (a pid is one process's at a time), left behind by a stop that couldn't clean up (a SIGKILL). One whose written-down
 * server group still runs is left as it is.
 */
function removeStaleOwnPid(checkDir, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mine = new RegExp(`^${esc}-${process.pid}(-[A-Za-z0-9]{6})?$`);
  for (const f of fs.readdirSync(checkDir)) {
    const full = path.join(checkDir, f);
    if (!mine.test(f) || madeHere.has(full)) continue;
    let group = null;
    try { group = JSON.parse(fs.readFileSync(path.join(full, "server.pid"), "utf8")).pgid; } catch { /* none written */ }
    if (Number.isInteger(group) && alive(-group)) continue;
    fs.rmSync(full, { recursive: true, force: true });
  }
}
/**
 * What every local wrangler of ours runs with (the check servers, the gate's, the demo; `npm run dev` through
 * scripts/dev.mjs; the older harnesses): no metrics sent, and no local trace store. wrangler dev (4.152) keeps every
 * request's trace under <state>/v3/observability/ by default (X_LOCAL_OBSERVABILITY), about 0.5 GB an hour while it runs;
 * nothing here reads it, and turning it off locally leaves the deployed site's Workers Logs as they are.
 */
export const LOCAL_WRANGLER_ENV = Object.freeze({ WRANGLER_SEND_METRICS: "false", X_LOCAL_OBSERVABILITY: "false" });
const DB_NAME = "wegoplace";

export class CheckError extends Error {}

/** JSON with comments and trailing commas (tools/jsonc.mjs). */
export { parseJsonc };

/** The pid listening on a TCP port, or null (lsof). */
function listenerPid(port) {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  const pid = Number((r.stdout || "").trim().split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
/** "pid 123 (workerd)" for whatever listens on a port, or null. */
function listenerOf(port) {
  const pid = listenerPid(port);
  if (!pid) return null;
  const name = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().split("/").pop();
  return `pid ${pid}${name ? ` (${name})` : ""}`;
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port });
  s.once("connect", () => { s.destroy(); resolve(false); });
  s.once("error", () => resolve(true));
});

/** What a check's server may take beside its port: the stand-ins and second servers at port + 1 … + 10, and each one's
 *  inspector a thousand above. */
export const PORT_SPAN = 10;

/** Where free ports are picked: below the OS's own range (49152 up), which it hands out in order, so a port it gives
 *  sits beside the ones it just gave other servers; and above the fixed ports the lanes and the film name (8xxx). */
const PICK = { from: 20000, to: 49152 - 1000 - PORT_SPAN };

/**
 * A port for a check's server when none is named (--port): picked at random in PICK, with port + 1 … + PORT_SPAN and
 * the inspectors a thousand above all free too, and clear of `avoid` (ports this check already chose). A check never
 * waits for a fixed port another lane's server or the film's capture holds: it takes another.
 */
export async function freePort({ avoid = [] } = {}) {
  for (let i = 0; i < 60; i++) {
    const p = PICK.from + Math.floor(Math.random() * (PICK.to - PICK.from));
    if (avoid.some((q) => Math.abs(q - p) <= PORT_SPAN)) continue;
    const span = Array.from({ length: PORT_SPAN + 1 }, (_, k) => [p + k, p + 1000 + k]).flat();
    if ((await Promise.all(span.map(portFree))).every(Boolean)) return p;
  }
  throw new CheckError(`no free port found for the check's server in 60 tries between ${PICK.from} and ${PICK.to}`);
}

/**
 * @param {object} o
 * @param {string} o.name        names the server's folder, .wrangler/check/<name>-<pid>-<six letters> (one of its own,
 *                               see the file's head), and its record
 * @param {number} o.port        the inspector takes port + 1000
 * @param {object} [o.vars]      settings on top of wrangler.jsonc's (PUBLIC_ORIGIN and RP_ID are set for the port)
 * @param {object} [o.secrets]   what a deployed site keeps as secrets
 * @param {boolean} [o.email]    bind Cloudflare's Email Sending (wrangler dev prints each email instead of sending it)
 * @param {"all"|string[]} [o.migrations]  "all", or migration file names to apply by hand, in order
 *                               (an absolute path is any SQL file: an export to start from)
 * @param {boolean} [o.keep]     leave the folder in place afterwards
 * @param {string} [o.main]      another Worker's entry file to run in place of this tree's (an older version's)
 * @param {boolean} [o.maps]     bind the trips' map maker (MAPS); check:map does, with WORLD_URL on this machine
 * @param {boolean} [o.strictlyPublic]  keep global_fetch_strictly_public, as production has it (client metadata documents on)
 * @param {string} [o.assets]    a folder to serve as the site's public files in place of the tree's (a deploy without some)
 * @param {boolean} [o.ai]       keep wrangler.jsonc's Workers AI binding (env.AI), which runs on the Cloudflare account even
 *                              from wrangler dev; off, it's dropped, and a check never reaches the account
 */
export async function startServer({ name, port, vars = {}, secrets = {}, email = false, migrations = "all", keep = false, main = null, maps = false, strictlyPublic = false, assets = null, ai = false }) {
  for (const r of recordedServers().filter((x) => x.port === port)) {
    if (!r.alive) { fs.rmSync(r.file, { force: true }); continue; }
    throw new CheckError(`a server an earlier check started (${r.check}, pid ${r.pid}, since ${r.started}) still runs on port ${port}. `
      + "It is this lane's: `node checks/lib/leftovers.mjs --stop` stops it by that record.");
  }
  if (!(await portFree(port))) throw new CheckError(`port ${port} is in use. Is another server still running? A check never stops a server it didn't start.`);
  const inspector = port + 1000;
  if (!(await portFree(inspector))) throw new CheckError(`port ${inspector} (the inspector) is in use`);

  const checkDir = path.join(ROOT, ".wrangler/check");
  fs.mkdirSync(checkDir, { recursive: true });
  if (SERVER_PLANT !== "keep-stale") removeStaleOwnPid(checkDir, name);
  const work = SERVER_PLANT === "same-name" ? path.join(checkDir, `${name}-${process.pid}`) : fs.mkdtempSync(path.join(checkDir, `${name}-${process.pid}-`));
  madeHere.add(work);
  const state = path.join(work, "state");
  fs.mkdirSync(state, { recursive: true });
  const origin = `http://localhost:${port}`;

  const config = parseJsonc(fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8"));
  delete config.$schema;
  // Workers AI runs on the account even from wrangler dev (no local simulation): only a run that asks keeps it.
  if (!ai) delete config.ai;
  // What wrangler.jsonc itself says of the rates provider (a check holds that it says nothing).
  const fxProvider = config.vars?.FX_PROVIDER_URL ?? null;
  const pictureFetchVia = config.vars?.PICTURE_FETCH_VIA ?? null;
  const rates = await startRates();
  // Far sites, for pictures fetched by address (checks/lib/far.mjs).
  const far = await startFar();
  // Its stand-ins (far sites, the rates provider) are on this machine, which a Worker with
  // global_fetch_strictly_public can't reach: the checks' Worker runs without it. check:mcp holds
  // that wrangler.jsonc itself has it.
  // `strictlyPublic` keeps it, as production has it: Client ID Metadata Documents are then on (the
  // OAuth provider fetches a client's document only under it), and nothing on this machine is
  // reachable from the Worker. Only check:mcp-sdk --cimd asks for it.
  if (!strictlyPublic) config.compatibility_flags = (config.compatibility_flags ?? []).filter((f) => f !== "global_fetch_strictly_public");
  config.main = main ?? path.join(ROOT, config.main);
  // An older version's entry (carry-over) exports no trips' rooms: their binding goes with it.
  const ownEntry = config.main;
  // The trips' map maker cuts from the world build over the network 15 s after an areas write: only
  // a check that asks for it (`maps`, check:map, with its world stood in on this machine) has it.
  // Every other check's server answers the map routes as a site without one does.
  if (!maps && config.durable_objects) config.durable_objects = { ...config.durable_objects, bindings: config.durable_objects.bindings.filter((b) => b.name !== "MAPS") };
  const rooms = { durable_objects: config.durable_objects, migrations: config.migrations };
  const forEntry = (entry) => {
    if (entry === ownEntry && !main) Object.assign(config, rooms);
    else { delete config.durable_objects; delete config.migrations; }
  };
  forEntry(config.main);
  config.assets.directory = assets ? path.resolve(assets) : path.join(ROOT, config.assets.directory);
  for (const db of config.d1_databases) db.migrations_dir = path.join(ROOT, db.migrations_dir);
  config.vars = { ...config.vars, PUBLIC_ORIGIN: origin, RP_ID: "localhost",
    FX_PROVIDER_URL: `http://127.0.0.1:${rates.address().port}/v6/latest/USD`, PICTURE_FETCH_VIA: far.url, ...vars };
  if (email) config.send_email = [{ name: "EMAIL" }];
  const configFile = path.join(work, "wrangler.json");
  // The rate limits as wrangler.jsonc sets them. A check can run the server with smaller ones
  // (start({ limits })): Cloudflare counts a limit per minute of the clock, which no check can
  // set, so a check that had to fill 1,200 inside a minute would fail on a busy machine.
  const configured = { limits: Object.fromEntries((config.ratelimits ?? []).map((r) => [r.name, r.simple.limit])), fxProvider, pictureFetchVia };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  // A secret set to null is left out, as on a site that never set it.
  const writeSecrets = () => fs.writeFileSync(path.join(work, ".dev.vars"),
    Object.entries(secrets).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
  writeSecrets();

  const env = {
    ...process.env, ...LOCAL_WRANGLER_ENV, WRANGLER_LOG_PATH: path.join(work, "logs"),
    CI: "1", NO_COLOR: "1", FORCE_COLOR: "0",
  };
  const wrangler = (argv, label) => {
    const r = spawnSync(WRANGLER, [...argv, "-c", configFile], { cwd: work, env, encoding: "utf8" });
    if (r.status !== 0) throw new CheckError(`${label} failed (exit ${r.status})\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  const d1 = (argv, label) => wrangler(["d1", ...argv, "--local", "--persist-to", state], label);

  const logFile = path.join(work, "server.log");
  let child = null;
  const record = path.join(PIDS, `${path.basename(work)}.json`);
  const forget = () => { fs.rmSync(record, { force: true }); fs.rmSync(path.join(work, "server.pid"), { force: true }); };
  // The process group this check last started (wrangler, workerd and their helpers), until it is gone: a halt waits for
  // all of it, not only the port, since a workerd still alive keeps the database files open.
  let group = null;
  const groupAlive = () => { if (!group) return false; try { process.kill(-group, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  // The same asked without the event loop, for the signal handler, which waits without returning: there Node never reaps
  // the server's exited processes, which stay in the group as zombies until it does. A zombie holds no file open, so
  // it is gone for the folder; read from ps, the group's processes that are not.
  const groupLiving = () => {
    if (!groupAlive()) return false;
    const r = spawnSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
    if (r.status !== 0) return true;
    return r.stdout.split("\n").some((l) => { const [g, st] = l.trim().split(/\s+/); return Number(g) === group && st && !st.startsWith("Z"); });
  };
  const stopChild = (signal = "SIGTERM") => {
    if (group && groupAlive()) {
      try { process.kill(-group, signal); } catch { /* already gone */ }
    }
  };
  const remove = () => {
    for (const s of [rates, far.server]) { try { s.close(() => {}); } catch { /* closed already */ } }
    if (keep) return;
    // Never from under a process of this server's that still lives: said, and the folder kept for the next look.
    if (groupLiving()) { console.log(`  (server ${name}: its process group ${group} still runs; its folder is kept: ${path.relative(ROOT, work)})`); return; }
    fs.rmSync(work, { recursive: true, force: true });
  };
  // Stopped by a signal: the server's group is ended and WAITED FOR (SIGTERM, SIGKILL past 10 s, given up past 20 s),
  // and only then is its folder removed, before the check exits. It waits here, in the handler, without returning: a
  // handler after it may exit the process at once (the browser launcher's does), and so this one is put first.
  // (27 Nov: the folder was removed only if the group was already gone the instant after its SIGTERM, which it never is;
  // a `gate.mjs --serve` stopped by a TERM to its group left every folder behind.)
  const onSignal = () => {
    if (SERVER_PLANT !== "no-wait") {
      stopChild("SIGTERM");
      const began = Date.now();
      let killed = false;
      while (groupLiving() && Date.now() - began < 20000) {
        if (!killed && Date.now() - began > 10000) { stopChild("SIGKILL"); killed = true; }
        pause(100);
      }
    } else stopChild("SIGTERM");
    forget(); remove();
  };
  // Taken off when it stops: a run that starts many servers in turn (the bake-off's fresh trip a task) keeps none of
  // the stopped ones'.
  hookSignals();
  onSignalStops.add(onSignal);
  const unhook = () => { onSignalStops.delete(onSignal); };

  const server = {
    origin, port, state, work, logFile, configured,
    /** The rates stand-in's own address, and how many times it was asked. */
    ratesUrl: `http://127.0.0.1:${rates.address().port}/v6/latest/USD`,
    ratesAsked: () => rates.asked ?? 0,
    /** The addresses the server asked the far sites' stand-in for, in order. */
    farAsked: () => [...far.asked],
    /** Each fetch the far sites' stand-in heard, with the User-Agent it came with. */
    farHeard: () => [...far.heard],
    log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").replace(/\x1b\[[0-9;]*m/g, "") : ""),
    /** Runs SQL in the server's database and returns the last statement's rows. */
    sql(command) {
      const out = d1(["execute", DB_NAME, "--json", "--command", command], "sql");
      return JSON.parse(out.slice(out.indexOf("["))).at(-1).results;
    },
    sqlFile(file) { d1(["execute", DB_NAME, "--file", file], `sql file ${path.basename(file)}`); },
    /**
     * The local database written out as SQL, by `wrangler d1 export --local`, as production's is
     * written. That command takes no --persist-to and reads wrangler's default place beside the
     * config (.wrangler/state), so that place is a link to this server's state.
     */
    export(file) {
      const where = path.join(work, ".wrangler");
      fs.mkdirSync(where, { recursive: true });
      if (!fs.existsSync(path.join(where, "state"))) fs.symlinkSync(state, path.join(where, "state"));
      wrangler(["d1", "export", DB_NAME, "--local", "--output", file], `export to ${path.basename(file)}`);
    },
    /** Where the log ends now: hand it to mailTo() to read only what is sent after this. */
    logMark: () => server.log().length,
    /**
     * The newest email to an address since `mark`, as { to, subject, text }, or null when none
     * came within `within` ms. Under wrangler dev no email leaves: each is printed in the log.
     */
    async mailTo(address, mark = 0, { within = 6000 } = {}) {
      const until = Date.now() + within;
      for (;;) {
        // Each is printed as its From, To and Subject and the path of a file holding its text.
        const mails = [...server.log().slice(mark).matchAll(/send_email binding called with[^\n]*\n((?:(?:From|To|Subject|Text|HTML):[^\n]*\n|\n)+)/g)]
          .map((m) => {
            const file = m[1].match(/^Text:\s*(.+)$/m)?.[1]?.trim();
            return {
              to: m[1].match(/^To:\s*.*?([^\s<,]+@[^\s>,]+)/m)?.[1]?.toLowerCase() ?? null,
              subject: m[1].match(/^Subject:\s*(.+)$/m)?.[1]?.trim() ?? "",
              text: file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "",
            };
          });
        const found = mails.filter((m) => m.to === address).at(-1);
        if (found) return found;
        if (Date.now() > until) return null;
        await new Promise((r) => setTimeout(r, 150));
      }
    },
    /** Whether a bucket holds an object under this key. */
    has(bucket, key) {
      const out = path.join(work, "object.tmp");
      const r = spawnSync(WRANGLER, ["r2", "object", "get", `${bucket}/${key}`, "--local", "--persist-to", state, "--file", out, "-c", configFile],
        { cwd: work, env, encoding: "utf8" });
      fs.rmSync(out, { force: true });
      return r.status === 0;
    },
    put(bucket, key, file) {
      wrangler(["r2", "object", "put", `${bucket}/${key}`, "--local", "--persist-to", state, "--file", file], `put ${key}`);
    },
    /** Starts (or starts again, on the same database, with other settings) the server. */
    async start(change = {}) {
      if (change.vars || change.main || change.limits) {
        config.vars = { ...config.vars, ...change.vars };
        if (change.main) { config.main = change.main; forEntry(config.main); }
        // { NAME: limit } for a rate limit by its binding's name; "configured" puts wrangler.jsonc's back.
        const limits = change.limits === "configured" ? configured.limits : change.limits ?? {};
        for (const [name, limit] of Object.entries(limits)) {
          const r = config.ratelimits?.find((x) => x.name === name);
          if (!r) throw new CheckError(`no rate limit named ${name} in wrangler.jsonc`);
          r.simple.limit = limit;
        }
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      }
      if (change.secrets) {
        secrets = { ...secrets, ...change.secrets };
        writeSecrets();
      }
      // Free again NOW, not only when the server was made: another check can take the port in
      // between (14 Nov: a rehearsal made at 11:13:39 started 45 s later on a port someone else's
      // server had taken meanwhile, and went on against it).
      if (!(await portFree(port))) throw new CheckError(`port ${port} is in use (by ${listenerOf(port) ?? "something"}): it was free when this check's server was made, and isn't now. A check never stops a server it didn't start.`);
      const log = fs.openSync(logFile, "a");
      child = spawn(WRANGLER, ["dev", "-c", configFile, "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(inspector),
        "--persist-to", state, "--show-interactive-dev-session=false", "--test-scheduled"], { cwd: work, env, detached: true, stdio: ["ignore", log, log] });
      group = child.pid;
      fs.mkdirSync(PIDS, { recursive: true });
      const written = JSON.stringify({ pid: child.pid, pgid: child.pid, port, check: name, runner: process.pid, started: new Date().toISOString(), work, tree: ROOT });
      fs.writeFileSync(record, written);
      fs.writeFileSync(path.join(work, "server.pid"), written);
      const deadline = Date.now() + 90000;
      for (;;) {
        if (child.exitCode !== null) throw new CheckError(`the server exited (code ${child.exitCode}); its log:\n${server.log().slice(-3000)}`);
        let answered = false;
        try { await request(origin, { path: "/login" }); answered = true; } catch { /* not up yet */ }
        if (answered) {
          // Whatever answers must be the server this check started: the listener's process is in
          // the group spawned above (detached, so its group is its pid). Anything else is someone
          // else's server, and the check stops its own and refuses rather than go on against it.
          const pid = listenerPid(port);
          const group = pid ? spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim() : "";
          if (pid && group && Number(group) !== child.pid) {
            stopChild();
            throw new CheckError(`port ${port} is answered by ${listenerOf(port)}, not this check's server (its group ${child.pid}). It went on no further.`);
          }
          break;
        }
        if (Date.now() > deadline) throw new CheckError(`the server didn't answer within 90 s; its log:\n${server.log().slice(-3000)}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    },
    /**
     * Stops the server and waits until its port, its inspector's and every process of its group are gone; the database
     * stays. SIGTERM first; past 10 s the group (this check's own, never another's) is ended with SIGKILL. Past 20 s it
     * is said, in one line in the check's log (the pid, how long), and the halt fails. (20 Nov: on a loaded machine the
     * inspector let go after the port, and the next server of the same run found it in use.)
     */
    async halt() {
      const began = Date.now();
      stopChild("SIGTERM");
      let killed = false;
      const done = async () => !groupAlive() && (await portFree(port)) && (await portFree(inspector));
      while (!(await done()) && Date.now() - began < 20000) {
        if (!killed && Date.now() - began > 10000) { stopChild("SIGKILL"); killed = true; }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!(await done())) {
        const what = groupAlive() ? `its process group ${group} still runs` : `port ${(await portFree(port)) ? inspector : port} is still taken`;
        const line = `server ${name}: ${what} ${Math.round((Date.now() - began) / 1000)} s after its halt began (SIGTERM, then SIGKILL at 10 s)`;
        console.log(`  (${line})`);
        try { fs.appendFileSync(logFile, `\n${line}\n`); } catch { /* the folder is gone */ }
        throw new CheckError(line);
      }
      child = null;
      group = null;
      forget();
    },
    /** Stops the server and removes its files; a halt that fails is said (by halt), and the files then stay. */
    async stop() {
      await server.halt().catch(() => {});
      remove();
      unhook();
    },
  };

  try {
    if (migrations === "all") d1(["migrations", "apply", DB_NAME], "migrations");
    // A name is a file in migrations/; an absolute path is any SQL file (an export, a plan's SQL).
    else for (const file of migrations) server.sqlFile(path.isAbsolute(file) ? file : path.join(ROOT, "migrations", file));
  } catch (error) {
    remove();
    unhook();
    throw error;
  }
  return server;
}
