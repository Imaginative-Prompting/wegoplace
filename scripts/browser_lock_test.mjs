#!/usr/bin/env node
/* NO BROWSER BESIDE ANOTHER LANE'S LANDING (scripts/lib/browser.mjs lockRefusal, refuseUnderAnothersLock). Starts no
 * browser: the rule on locks of this test's own, then the launcher itself in a child process.
 *
 *   1. THE RULE. No lock: a launch goes. A lock whose `who` starts with the caller's name (WGP_LANE), a name with
 *      spaces included: it goes. Held by anyone else, by a name that only starts the same ("wgp-x" under
 *      "wgp-xyz"), with no WGP_LANE at all, or by a lock folder with no `who` in it: refused, the line naming the
 *      holder.
 *   2. THE LAUNCHER. A child process imports scripts/lib/browser.mjs with WGP_LOCK naming a lock held by someone
 *      else and calls what launchChrome() calls just before a browser starts: it exits 75 with one line, and nothing
 *      after it runs. With the
 *      lock its own, it goes on. And gate.mjs refuses an --only that names nothing (an empty list would run the gate).
 *
 * Planted: BLOCK_PLANT=open serves the child a copy of the launcher whose refusal doesn't exit (2 red: the launch
 * goes on under another lane's lock).
 *
 *   node scripts/browser_lock_test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lockRefusal } from "./lib/browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(HERE, "lib/browser.mjs");
const PLANT = process.env.BLOCK_PLANT || "";
if (PLANT && PLANT !== "open") throw new Error(`no such plant: ${PLANT}`);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-lock-test-"));
const lockAt = (name, who) => { const dir = path.join(tmp, name, "landing.lock"); fs.mkdirSync(dir, { recursive: true }); if (who !== null) fs.writeFileSync(path.join(dir, "who"), who + "\n"); return path.join(dir, "who"); };

try {
  section("1. The rule, on locks of its own");
  const none = path.join(tmp, "none", "landing.lock", "who");
  const mine = lockAt("mine", "wgp-x 12:00 a landing");
  const spaced = lockAt("spaced", "wegoplace director 14:57 my three, then deploy");
  const theirs = lockAt("theirs", "wgp-other 13:00 their gate");
  const longer = lockAt("longer", "wgp-xyz 13:00 a longer name");
  const unnamed = lockAt("unnamed", null);
  check("no lock: it goes", lockRefusal({ files: [none], lane: "wgp-x" }) === null);
  check("the caller's own lock: it goes", lockRefusal({ files: [mine], lane: "wgp-x" }) === null);
  check("its own, a name with a space (\"wegoplace director\"): it goes", lockRefusal({ files: [spaced], lane: "wegoplace director" }) === null);
  const r1 = lockRefusal({ files: [theirs], lane: "wgp-x" });
  check("another lane's lock: refused, naming the holder", !!r1 && r1.includes("wgp-other 13:00"), r1);
  check("a name that only starts the same (wgp-x under wgp-xyz): refused", !!lockRefusal({ files: [longer], lane: "wgp-x" }));
  check("only the first part of a spaced name (wegoplace under \"wegoplace director\"): refused", !!lockRefusal({ files: [theirs], lane: "wgp" }) && !!lockRefusal({ files: [spaced], lane: "wegoplace directo" }));
  const r2 = lockRefusal({ files: [mine], lane: "" });
  check("no WGP_LANE while any lock is held: refused", !!r2 && /no WGP_LANE/.test(r2), r2);
  const r3 = lockRefusal({ files: [unnamed], lane: "wgp-x" });
  check("a lock folder with no who: refused, by someone unnamed", !!r3 && /someone unnamed/.test(r3), r3);
  check("two locks, the second another's: refused", !!lockRefusal({ files: [mine, theirs], lane: "wgp-x" }));

  section("2. The launcher, in a child process");
  let launcher = LAUNCHER;
  if (PLANT === "open") {
    const src = fs.readFileSync(LAUNCHER, "utf8");
    const t = src.replace('if (why) { process.stderr.write(why + "\\n"); process.exit(75); }', 'if (why) process.stderr.write(why + "\\n");');
    if (t === src) throw new Error("the open plant didn't take");
    launcher = path.join(tmp, "browser-open.mjs"); fs.writeFileSync(launcher, t);
  }
  // The machine's own lock is read too (it can't be taken away): when it is held, the child is its holder in the
  // "its own" case, so that case judges the launcher and not whoever is landing right now.
  let real = "";
  try { real = fs.readFileSync(path.join(os.userInfo().homedir, "Documents/GitHub/imaginative-prompting/16-wegoplace/lanes/landing.lock/who"), "utf8").trim(); } catch {}
  const child = (lock, lane) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify("file://" + launcher)}); m.refuseUnderAnothersLock(); console.log("WENT ON");`],
    { env: { ...process.env, WGP_LOCK: lock, WGP_LANE: lane }, encoding: "utf8" });
  const held = child(theirs, real || "wgp-x");
  const lines = held.stderr.trim().split("\n").filter(Boolean);
  check("under another lane's lock: exit 75, one line, and nothing after it ran", held.status === 75 && lines.length === 1 && /^REFUSED: /.test(lines[0]) && !/WENT ON/.test(held.stdout),
    JSON.stringify({ status: held.status, stderr: held.stderr.trim().slice(0, 200), stdout: held.stdout.trim() }));
  const ownLock = lockAt("own", real || "wgp-x 12:00 a landing");
  const own = child(ownLock, real || "wgp-x");
  check("under its own lock: it goes on", own.status === 0 && /WENT ON/.test(own.stdout), JSON.stringify({ status: own.status, stderr: own.stderr.trim().slice(0, 200) }));
  const gate = spawnSync(process.execPath, [path.join(HERE, "gate.mjs"), "--only", ""], { encoding: "utf8", env: { ...process.env, WGP_LANE: "wgp-x" } });
  check("gate.mjs --only \"\": refused before anything runs (exit 2)", gate.status === 2 && /names no check/.test(gate.stderr), JSON.stringify({ status: gate.status, stderr: gate.stderr.trim().slice(0, 200) }));
} catch (e) {
  fail++; failures.push(`threw: ${e.message}`); console.log(`  FAIL  threw: ${e.stack || e}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  FAILED  ${f}`); process.exit(1); }
