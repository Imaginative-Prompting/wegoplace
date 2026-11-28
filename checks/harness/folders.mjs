// A check server's folder (checks/lib/server.mjs, .wrangler/check/): one of its own, and gone when it is stopped,
// however it is stopped. 27 Nov: named <name>-<pid> alone, a `gate.mjs --serve` stopped by a TERM to its process group
// left its folder behind every time (one lane held 1,138 of them, 8.2 GB), and with the pids wrapping a new copy got an
// old copy's pid, opened its database, and failed its seed with 409.
//
//   node checks/harness/folders.mjs
//
// 1. Two servers of one name in one process: two folders, neither the bare <name>-<pid>.
// 2. A folder left by an earlier process with this one's pid and this name (both namings) is removed before a server
//    starts; one of another name is left as it is.
// 3. `gate.mjs --serve` (the gate's server and its made-up trip), stopped by a SIGTERM to its process group: it exits,
//    its server's processes are gone, and its folder is gone.
// 4. The same stopped by a SIGINT to the gate's process alone.
// 5. A check with two servers up, stopped by a SIGTERM: both servers' processes and both folders are gone.
//
// PLANTED (WGP_SERVER_PLANT=<name>, read by checks/lib/server.mjs, here and in the gates it starts):
//   same-name   the folder named <name>-<pid> again: 1 red.
//   keep-stale  no removal of an earlier process's folder: 2 red.
//   no-wait     the folder removed on a signal only if the processes are already gone: 3, 4 and 5 red.
//   first-only  one server of several stopped on a signal: 5 red.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, startServer, freePort } from "../lib/server.mjs";
import { Report } from "../lib/person.mjs";

const t = new Report("a check server's folder");
const CHECK_DIR = path.join(ROOT, ".wrangler/check");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
if (process.env.WGP_SERVER_PLANT) console.log(`PLANTED: ${process.env.WGP_SERVER_PLANT} (checks/lib/server.mjs)`);

const made = [];
let code = 1;
try {
  t.part("1. Two servers of one name in one process");
  const a = await startServer({ name: "folders-twin", port: await freePort() });
  made.push(a);
  const b = await startServer({ name: "folders-twin", port: await freePort({ avoid: [a.port] }) });
  made.push(b);
  t.ok("each has a folder of its own", a.work !== b.work, { a: a.work, b: b.work });
  t.ok("neither is the bare <name>-<pid>", ![a.work, b.work].includes(path.join(CHECK_DIR, `folders-twin-${process.pid}`)), { a: a.work, b: b.work });
  await b.stop();
  await a.stop();
  t.ok("both are removed by their stop()", !fs.existsSync(a.work) && !fs.existsSync(b.work));

  t.part("2. A folder an earlier process with this pid left");
  const stale = [path.join(CHECK_DIR, `folders-stale-${process.pid}`), path.join(CHECK_DIR, `folders-stale-${process.pid}-Ab12Cd`)];
  const other = path.join(CHECK_DIR, `folders-other-${process.pid}-Zz99Yy`);
  for (const dir of [...stale, other]) {
    fs.mkdirSync(path.join(dir, "state"), { recursive: true });
    fs.writeFileSync(path.join(dir, "state", "left.txt"), "an earlier process's database");
  }
  const c = await startServer({ name: "folders-stale", port: await freePort() });
  made.push(c);
  t.ok("both namings of this name and pid are removed before the server starts", stale.every((d) => !fs.existsSync(d)), stale.filter((d) => fs.existsSync(d)));
  t.ok("the new server's database is empty of them", !fs.existsSync(path.join(c.state, "left.txt")));
  t.ok("a folder of another name is left as it is", fs.existsSync(path.join(other, "state", "left.txt")));
  for (const dir of [...stale, other]) fs.rmSync(dir, { recursive: true, force: true });     // this check's own, whatever happened
  await c.stop();

  // ── 3 and 4: the gate's own server, stopped by a signal ──
  async function serveAndStop(label, stop) {
    const log = [];
    const gate = spawn(process.execPath, ["scripts/gate.mjs", "--serve", "--who", "harness-folders"],
      { cwd: ROOT, env: { ...process.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    gate.stdout.on("data", (d) => log.push(String(d)));
    gate.stderr.on("data", (d) => log.push(String(d)));
    const exited = new Promise((r) => gate.on("exit", (c, s) => r({ code: c, signal: s })));
    const until = Date.now() + 240000;
    let card = null;
    while (!card && Date.now() < until && gate.exitCode === null) {
      card = log.join("").match(/WGP_GATE_CARD=(\S+)/)?.[1] ?? null;
      if (!card) await sleep(500);
    }
    if (!t.ok(`${label}: the gate's server comes up`, card, log.join("").slice(-2000))) { try { process.kill(-gate.pid, "SIGKILL"); } catch { /* gone */ } return; }
    const work = path.dirname(card);
    const server = JSON.parse(fs.readFileSync(path.join(work, "server.pid"), "utf8"));
    t.ok(`${label}: its folder is one of its own (<name>-<pid>-<six letters>)`, /-\d+-[A-Za-z0-9]{6}$/.test(path.basename(work)), work);
    stop(gate);
    const how = await Promise.race([exited, sleep(40000).then(() => null)]);
    t.ok(`${label}: the gate exits`, how, log.join("").slice(-1500));
    if (!how) { try { process.kill(-gate.pid, "SIGKILL"); } catch { /* gone */ } }
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) { gone = !alive(-server.pgid); if (!gone) await sleep(250); }
    t.ok(`${label}: its server's processes are gone`, gone, `group ${server.pgid}`);
    t.ok(`${label}: its folder is gone`, !fs.existsSync(work), `${path.relative(ROOT, work)} is still there; the gate said: ${log.join("").slice(-600)}`);
    if (fs.existsSync(work) && gone) fs.rmSync(work, { recursive: true, force: true });
  }
  t.part("3. gate.mjs --serve, a SIGTERM to its process group");
  await serveAndStop("TERM to the group", (gate) => process.kill(-gate.pid, "SIGTERM"));
  t.part("4. gate.mjs --serve, a SIGINT to its process");
  await serveAndStop("INT to the process", (gate) => process.kill(gate.pid, "SIGINT"));

  t.part("5. A check with two servers up, a SIGTERM");
  {
    const p1 = await freePort();
    const p2b = await freePort({ avoid: [p1] });
    const two = spawn(process.execPath, ["--input-type=module", "-e", `
      import { startServer } from ${JSON.stringify(path.join(ROOT, "checks/lib/server.mjs"))};
      const a = await startServer({ name: "folders-pair-a", port: ${p1} }); await a.start();
      const b = await startServer({ name: "folders-pair-b", port: ${p2b} }); await b.start();
      console.log("UP " + JSON.stringify([a.work, b.work]));
      await new Promise(() => {});`], { cwd: ROOT, env: { ...process.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    two.stdout.on("data", (d) => out.push(String(d)));
    two.stderr.on("data", (d) => out.push(String(d)));
    const exited = new Promise((r) => two.on("exit", (c, s) => r({ code: c, signal: s })));
    let works = null;
    const until = Date.now() + 180000;
    while (!works && Date.now() < until && two.exitCode === null) {
      const m = out.join("").match(/UP (\[.*\])/);
      if (m) works = JSON.parse(m[1]); else await sleep(300);
    }
    if (t.ok("two servers come up in one check", works, out.join("").slice(-1500))) {
      const groups = works.map((w) => JSON.parse(fs.readFileSync(path.join(w, "server.pid"), "utf8")).pgid);
      process.kill(two.pid, "SIGTERM");
      const how = await Promise.race([exited, sleep(50000).then(() => null)]);
      t.ok("the check exits", how, out.join("").slice(-800));
      if (!how) { try { process.kill(-two.pid, "SIGKILL"); } catch { /* gone */ } }
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) { gone = groups.every((g) => !alive(-g)); if (!gone) await sleep(250); }
      t.ok("both servers' processes are gone", gone, groups);
      t.ok("both folders are gone", works.every((w) => !fs.existsSync(w)), works.filter((w) => fs.existsSync(w)).map((w) => path.relative(ROOT, w)));
      if (!gone) {
        // This check's own servers, left by the fault: ended, waited for, and their folders removed all the same.
        for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
        for (let i = 0; i < 40 && groups.some((g) => alive(-g)); i++) await sleep(250);
      }
      for (const w of works) fs.rmSync(w, { recursive: true, force: true });
    } else { try { process.kill(-two.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  code = t.end();
} catch (error) {
  console.log(`\nstopped: ${error?.stack ?? error}`);
  for (const s of made) await s.stop().catch(() => {});
}
process.exit(code);
