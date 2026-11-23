#!/usr/bin/env node
// A bounded, niced CPU load, for running a check the way it runs when the machine is busy (a
// browser check that is green alone and red during a full gate, say), and saying how busy it was.
//
//   node tools/cpu-load.mjs [--workers N] [--seconds S] [--nice K] [--every T] [--out <summary.json>]
//   node tools/cpu-load.mjs [the same] [--warm W] -- <command> [args…]
//
//   --workers N   busy threads, each spinning one core (default: half the cores; at most every core)
//   --seconds S   the hard cap on the load, from its start (default 300; more than 600 is refused).
//                 The load stops at the cap whatever is running; a command still running then runs
//                 on without it, and the summary says the run was not loaded to its end
//   --nice K      the load's niceness, 1 to 19 (default 19, the lowest Node sets): it takes
//                 only time nothing else wants, so it never holds up a render or a person
//   --every T     print the machine's 1-minute load average every T seconds (default 10)
//   --warm W      with a command: seconds of load before the command starts (default 60), since the
//                 1-minute average takes about a minute to climb to the load it measures
//   --out <file>  a JSON summary: every sample, the load while the command ran (least, most, mean),
//                 the command's exit code and time, and whether the whole run was under load
//
// With a command, the command runs at its own priority (it is started from this process, which is
// never niced; only the load's own process is), the load stops as soon as the command ends, and
// this exits with the command's code. Without one, the load runs to the cap.
//
// It signals only what it started: the load's process (whose threads end with it) and the command.
// Ctrl-C (SIGINT) or SIGTERM stops the load and passes SIGINT to the command. The load also stops
// itself at the cap if this process is gone (killed outright): its process watches the cap on its
// own, each thread checks the time, and it ends when the channel to this process closes.
//
// Run it with the Bash sandbox off: inside the sandbox a nice level can be set and read back
// without taking effect.

import { fork, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { Worker } from "node:worker_threads";

const LOAD_CHILD = "--load-child";

if (process.argv[2] === LOAD_CHILD) loadChild(JSON.parse(process.argv[3]));
else await main();

/** The load: niced, its threads spinning until the deadline, or until told to stop. */
function loadChild({ workers, deadline, nice }) {
  try { os.setPriority(nice); } catch (e) { process.send({ refused: `couldn't set nice ${nice}: ${e.message}` }); process.exit(2); }
  const got = os.getPriority();
  if (got !== nice) { process.send({ refused: `nice reads back ${got}, not ${nice}` }); process.exit(2); }
  const spin = `const { workerData } = require("node:worker_threads");
    let x = 0;
    while (Date.now() < workerData.deadline) for (let i = 0; i < 2e6; i++) x += Math.sqrt(i);`;
  const threads = Array.from({ length: workers }, () => new Worker(spin, { eval: true, workerData: { deadline } }));
  let ended = 0;
  const stop = () => { for (const t of threads) t.terminate(); process.exit(0); };
  for (const t of threads) t.on("exit", () => { if (++ended === threads.length) process.exit(0); });
  setTimeout(stop, Math.max(0, deadline - Date.now()) + 1000);
  process.on("disconnect", stop);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.send({ ready: true, pid: process.pid, nice: got, threads: threads.length });
}

function usage(why) {
  console.error(`refused: ${why}\nusage: node tools/cpu-load.mjs [--workers N] [--seconds S] [--nice K] [--every T] [--warm W] [--out <file>] [-- <command> …]`);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf("--");
  const own = dash < 0 ? argv : argv.slice(0, dash);
  const command = dash < 0 ? [] : argv.slice(dash + 1);
  if (dash >= 0 && !command.length) usage("nothing after --");
  const known = new Set(["--workers", "--seconds", "--nice", "--every", "--warm", "--out"]);
  const opts = {};
  for (let i = 0; i < own.length; i += 2) {
    if (!known.has(own[i]) || own[i + 1] == null) usage(`don't know ${JSON.stringify(own[i])}${own[i + 1] == null ? " (or it has no value)" : ""}`);
    opts[own[i].slice(2)] = own[i + 1];
  }
  const cores = os.availableParallelism();
  const num = (name, dflt) => {
    if (opts[name] == null) return dflt;
    const n = Number(opts[name]);
    if (!Number.isFinite(n)) usage(`--${name} must be a number`);
    return n;
  };
  const workers = num("workers", Math.max(1, Math.floor(cores / 2)));
  const seconds = num("seconds", 300);
  const nice = num("nice", 19);
  const every = num("every", 10);
  const warm = command.length ? num("warm", 60) : 0;
  if (!Number.isInteger(workers) || workers < 1 || workers > cores) usage(`--workers is a whole number from 1 to ${cores} (this machine's cores)`);
  if (!(seconds > 0) || seconds > 600) usage("--seconds is more than 0 and at most 600");
  if (!Number.isInteger(nice) || nice < 1 || nice > 19) usage("--nice is a whole number from 1 to 19 (the load is always niced)");
  if (!(every >= 1)) usage("--every is at least 1");
  if (!(warm >= 0) || warm >= seconds) usage("--warm is at least 0 and less than --seconds");

  const say = (line) => console.log(`[cpu-load] ${line}`);
  const load1 = () => Math.round(os.loadavg()[0] * 100) / 100;
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / 1000);
  const summary = {
    cores, workers, nice, capSeconds: seconds, warmSeconds: warm, everySeconds: every,
    startedAt: new Date(t0).toISOString(), loadBefore: load1(), samples: [],
    command: command.length ? command.join(" ") : null, commandSeconds: null, exitCode: null,
    loadWhileCommandRan: null, wholeRunUnderLoad: null, stoppedBy: null,
  };
  const deadline = t0 + seconds * 1000;

  const child = fork(new URL(import.meta.url).pathname, [LOAD_CHILD, JSON.stringify({ workers, deadline, nice })], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const childGone = new Promise((ok) => child.once("exit", ok));
  const first = await new Promise((ok) => { child.once("message", ok); child.once("exit", (code) => ok({ refused: `the load's process ended first (${code})` })); });
  if (first.refused) { say(`refused: ${first.refused}`); process.exit(2); }
  say(`load on: ${first.threads} busy threads at nice ${first.nice} in pid ${first.pid} (this is pid ${process.pid}); ${cores} cores; cap ${seconds} s; 1-min load before ${summary.loadBefore}`);

  let loadOn = true;
  let cmd = null;
  let cmdStart = null;
  let cmdSamples = [];
  const sample = (why) => {
    const s = { t: at(), load1: load1(), loadOn, commandRunning: !!cmd, why };
    summary.samples.push(s);
    if (cmd && loadOn) cmdSamples.push(s.load1);
    return s;
  };
  const ticker = setInterval(() => { const s = sample("tick"); say(`t=${String(s.t).padStart(4)} s  1-min load ${s.load1.toFixed(2)}${s.loadOn ? "" : "  (load off)"}${s.commandRunning ? "  command running" : ""}`); }, every * 1000);

  const stopLoad = async (why) => {
    if (!loadOn) return;
    sample(`load stops: ${why}`);
    loadOn = false;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const late = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
    await childGone;
    clearTimeout(late);
    say(`load off at t=${at()} s (${why})`);
  };

  const finish = (code) => {
    clearInterval(ticker);
    if (cmdSamples.length) {
      summary.loadWhileCommandRan = { least: Math.min(...cmdSamples), most: Math.max(...cmdSamples), mean: Math.round(cmdSamples.reduce((a, b) => a + b, 0) / cmdSamples.length * 100) / 100, samples: cmdSamples.length };
    }
    summary.endedAt = new Date().toISOString();
    if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(summary, null, 2) + "\n");
    const w = summary.loadWhileCommandRan;
    say(`done: ${summary.stoppedBy}${summary.command ? `; the command took ${summary.commandSeconds} s, exit ${summary.exitCode}, under load to its end: ${summary.wholeRunUnderLoad ? "yes" : "NO"}${w ? `; 1-min load while it ran ${w.least}–${w.most} (mean ${w.mean}, ${w.samples} samples)` : ""}` : ""}`);
    process.exit(code);
  };

  let stopping = false;
  const onSignal = async (sig) => {
    if (stopping) return;
    stopping = true;
    summary.stoppedBy = sig;
    if (cmd && cmd.exitCode === null && cmd.signalCode === null) cmd.kill("SIGINT");
    await stopLoad(sig);
    if (cmd && cmd.exitCode === null && cmd.signalCode === null) await new Promise((ok) => cmd.once("exit", ok));
    finish(130);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // The cap, kept here too: the load stops at it whatever is running.
  const cap = setTimeout(async () => {
    if (cmd) { summary.wholeRunUnderLoad = false; say("the cap: the command runs on without the load"); }
    await stopLoad("the cap");
    if (!cmd || cmd.exitCode !== null || cmd.signalCode !== null) { summary.stoppedBy = "the cap"; finish(0); }
  }, seconds * 1000);

  // The load's own process ends itself at the cap (its threads watch the time too); anything earlier is said.
  child.once("exit", () => {
    if (!loadOn || stopping) return;
    sample("the load's process ended");
    loadOn = false;
    say(Date.now() >= deadline - 1000 ? `load off at t=${at()} s (the cap)` : `the load's process ended early, at t=${at()} s`);
  });

  if (!command.length) return;
  if (warm > 0) { say(`warming ${warm} s before the command`); await new Promise((ok) => setTimeout(ok, warm * 1000)); }
  if (stopping) return;
  cmdStart = Date.now();
  say(`command starts at t=${at()} s: ${summary.command}`);
  cmd = spawn(command[0], command.slice(1), { stdio: "inherit" });
  sample("command starts");
  let ended = false;
  const onEnd = async (code, signal) => {
    if (ended) return;
    ended = true;
    summary.commandSeconds = Math.round((Date.now() - cmdStart) / 100) / 10;
    summary.exitCode = code ?? (signal ? `signal ${signal}` : null);
    if (summary.wholeRunUnderLoad === null) summary.wholeRunUnderLoad = loadOn;
    sample("command ends");
    if (stopping) return;
    clearTimeout(cap);
    summary.stoppedBy = "the command ended";
    await stopLoad("the command ended");
    finish(typeof code === "number" ? code : 1);
  };
  cmd.once("error", (e) => { say(`the command couldn't start: ${e.message}`); onEnd(127, null); });
  cmd.once("exit", onEnd);
}
