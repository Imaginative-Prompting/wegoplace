#!/usr/bin/env node
/* The relay places a page's error by the page that sent it (proxy.mjs whereError), not by whichever page said hello
 * last. Node only: no browser, no Simulator.
 *
 *   1. Through the relay itself (startProxy on a free port, a small site behind it): a page "/" says hello, a page
 *      "/trips" says hello 100 ms later (as index.html's location.replace("/trips") gives on a Home Screen launch), then
 *      "/" says goodbye and sends an error. The error is put on "/", after its goodbye, with "/trips" the live page.
 *   2. An error from "/trips" while it is the live page is put there, as the live page.
 *   3. An error from a page that never said hello is said to be one.
 *   4. Both probes (full and bare) say goodbye on pagehide, and every page the relay serves carries one of them.
 *
 *   node scripts/ios/where_error_test.mjs
 *
 * IOS_WHERE_PLANT=lasthello places each error by the last hello, as phone.mjs did before (red: 1 and 3).
 */
import http from "node:http";
import { startProxy, whereError } from "./proxy.mjs";
import { freeLoopbackPort } from "../lib/browser.mjs";

const PLANT = process.env.IOS_WHERE_PLANT || "";
if (PLANT && PLANT !== "lasthello") throw new Error(`no such plant: ${PLANT}`);
const place = PLANT ? (st) => { const h = st.hellos.at(-1); return { path: h ? h.path : "?", live: true, words: h ? h.path : "?" }; } : whereError;

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `   ${ok ? "—" : "->"} ${String(detail).slice(0, 400)}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const site = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<!doctype html><html><head><title>t</title></head><body>a page</body></html>"); });
const upstream = await freeLoopbackPort();
await new Promise((r) => site.listen(upstream, "127.0.0.1", r));
const listen = await freeLoopbackPort();
const relays = [];
try {
  const relay = startProxy({ listen, upstream });
  relays.push(relay);
  await relay.ready;
  const say = (page, kind, data) => fetch(`http://127.0.0.1:${listen}/api/__probe/in`, { method: "POST", body: JSON.stringify({ page, kind, data }) });

  // 1. "/" replaced by "/trips" as it starts; "/"'s error comes after.
  await say("pg-root", "hello", { path: "/", standalone: true, controlled: false });
  await sleep(100);
  await say("pg-trips", "hello", { path: "/trips", standalone: true, controlled: false });
  await sleep(20);
  await say("pg-root", "bye", { path: "/" });
  await sleep(30);
  await say("pg-root", "error", "Script error. @ (no file):0:0");
  await sleep(50);
  const st = relay.st;
  check("the relay keeps each error with the page that sent it and when", st.errorLog.length === 1 && st.errorLog[0].page === "pg-root" && st.errorLog[0].at > 0 && st.errors[0] === "Script error. @ (no file):0:0",
    JSON.stringify(st.errorLog));
  check("and each page's goodbye", st.byes.length === 1 && st.byes[0].page === "pg-root" && st.byes[0].path === "/", JSON.stringify(st.byes));
  const one = place(st, st.errorLog[0]);
  check(`1. an error sent by "/" after "/trips" said hello is put on "/", after its goodbye, not as the live page`,
    one.path === "/" && one.live === false && one.sinceBye >= 0 && /after its goodbye/.test(one.words) && /\/trips had said hello/.test(one.words), one.words);

  // 2. "/trips" as the live page.
  await say("pg-trips", "error", "TypeError: x is undefined @ /js/trips.js:10:5");
  await sleep(50);
  const two = place(st, st.errorLog[1]);
  check(`2. an error sent by "/trips" while it is the live page is put there, as the live page`, two.path === "/trips" && two.live === true, two.words);
  if (!PLANT) check("   and its words say it was the live page", /the live page then/.test(two.words), two.words);

  // 3. A page that never said hello.
  await say("pg-ghost", "error", "Script error. @ (no file):0:0");
  await sleep(50);
  const three = place(st, st.errorLog[2]);
  check("3. an error from a page that never said hello is said to be one", /never said hello/.test(three.words) && three.live === false, three.words);

  // 4. Every page the relay serves carries a probe that says goodbye on pagehide, the bare one too.
  const full = await (await fetch(`http://127.0.0.1:${listen}/`)).text();
  const bareListen = await freeLoopbackPort();
  const bareRelay = startProxy({ listen: bareListen, upstream, bare: true });
  relays.push(bareRelay);
  await bareRelay.ready;
  const bare = await (await fetch(`http://127.0.0.1:${bareListen}/`)).text();
  const bye = /addEventListener\("pagehide", \(\) => post\("bye"/;
  check("4. the full probe says goodbye on pagehide", bye.test(full) && /window\.__probe/.test(full) && /__probe\/cmd/.test(full), full.slice(0, 120));
  check("   and so does the bare one", bye.test(bare) && /bare-/.test(bare) && !/__probe\/cmd/.test(bare), bare.slice(0, 120));
} catch (e) {
  fail++;
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  for (const r of relays) r.stop();
  site.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
