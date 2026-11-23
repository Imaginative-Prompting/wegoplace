// The checks' own harness (checks/lib/server.mjs): a check never goes on against a server that
// isn't its own. 14 Nov: a rehearsal made its server while the port was free, another check took
// the port meanwhile, and the rehearsal's start() took that server's answer as its own.
//
//   node checks/harness/run.mjs [--port 8796]
//
// 1. A server on the port before startServer: refused, as it always was.
// 2. The port taken between making the server and start(): refused before anything is launched.
// 3. The port taken just after start() launches, before the check's own server binds: the answer
//    comes from someone else's process, and start() stops its own and refuses, naming that pid.
// 4. With the port free, start() runs and the server is the check's own.
// Everything planted is this check's own small HTTP server, closed at the end.

import http from "node:http";
import { CheckError, startServer } from "../lib/server.mjs";
import { Report } from "../lib/person.mjs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const port = Number(flag("--port") ?? 8796);
const t = new Report("the checks' harness");
let code = 1;
const planted = [];

/** A small server of this check's own on the port, answering anything. */
function plant() {
  const s = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("someone else's server"); });
  planted.push(s);
  return new Promise((resolve, reject) => { s.once("error", reject); s.listen(port, "127.0.0.1", () => resolve(s)); });
}
const unplant = (s) => new Promise((r) => s.close(r));
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof CheckError ? e.message : `not a refusal: ${e?.message ?? e}`; } };

try {
  t.part("1. A server already on the port");
  let s = await plant();
  const early = await refusal(() => startServer({ name: "harness-early", port }));
  t.ok("startServer refuses, in words", /port \d+ is in use/.test(early ?? ""), early);
  await unplant(s);

  t.part("2. The port taken between making the server and starting it");
  let server = await startServer({ name: "harness-between", port });
  s = await plant();
  const between = await refusal(() => server.start());
  t.ok("start() refuses before launching anything, naming who has the port", /it was free when this check's server was made, and isn't now/.test(between ?? "") && /pid \d+/.test(between ?? ""), between);
  await unplant(s);
  await server.stop();

  t.part("3. The port taken just after start() launches");
  server = await startServer({ name: "harness-race", port });
  const started = server.start();
  s = await plant();       // before wrangler binds (it takes seconds): the planted server answers first
  const race = await refusal(() => started);
  t.ok("the answer comes from someone else's process: start() stops its own server and refuses, naming that pid", /is answered by pid \d+.*not this check's server/.test(race ?? ""), race);
  await unplant(s);
  await server.stop();

  t.part("4. The port free");
  server = await startServer({ name: "harness-free", port });
  await server.start();
  const res = await fetch(`${server.origin}/login`);
  t.ok("start() runs and the server answering is the check's own (the sign-in page)", res.status === 200 && /<html/i.test(await res.text()));
  await server.stop();
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  for (const s of planted) s.close();
}
process.exit(code);
