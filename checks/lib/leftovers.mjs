// The servers this lane's checks started and didn't stop, found by what checks/lib/server.mjs
// wrote down when it started each (its pid, port and check), and by nothing else: both lanes'
// servers carry lanes/server/node_modules in their command lines, so a process list proves
// nothing about whose a server is.
//
//   node checks/lib/leftovers.mjs          lists them
//   node checks/lib/leftovers.mjs --stop   stops each one still running, by its recorded group,
//                                          once its command line (read whole) still says it is
//                                          the wrangler dev on the recorded port; removes records
//                                          of servers already gone

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { PIDS, recordedServers } from "./server.mjs";

const stop = process.argv.includes("--stop");
const rows = recordedServers();
if (!rows.length) console.log(`no server recorded under ${PIDS}`);
for (const r of rows) {
  if (!r.alive) {
    console.log(`gone     ${r.check} pid ${r.pid} port ${r.port}: removing its record`);
    if (stop) fs.rmSync(r.file, { force: true });
    continue;
  }
  let command = "";
  try { command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(r.pid)], { encoding: "utf8" }).trim(); } catch { command = ""; }
  const same = command.includes("wrangler") && command.includes(" dev ") && command.includes(`--port ${r.port} `);
  if (!same) {
    console.log(`MISMATCH ${r.check} pid ${r.pid}: the process with that pid now is "${command.slice(0, 160)}", not the recorded server. Left alone; its record removed.`);
    if (stop) fs.rmSync(r.file, { force: true });
    continue;
  }
  console.log(`running  ${r.check} pid ${r.pid} (its group) port ${r.port}, since ${r.started}`);
  if (stop) {
    try { process.kill(-r.pgid, "SIGTERM"); console.log("         stopped"); } catch (e) { console.log(`         couldn't stop it: ${e.message}`); }
    fs.rmSync(r.file, { force: true });
  }
}
