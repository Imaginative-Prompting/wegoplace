#!/usr/bin/env node
/* A PAGE LOAD'S TOP-UP NEVER HOLDS AN UPDATE BACK: public/sw.js run in node, on a clock of this test's own.
 *
 * A new worker that has installed takes over only once the worker in control has no work left that a page load
 * handed it (waitUntil). The top-up a page load starts (topUp: whatever install missed, then the photographs) can
 * take as long as the line lets it, so:
 *
 *   1. THE CEILING. The shell is missing and every file the top-up asks for is held, never answered. The page load
 *      hands its worker work that ends at TOPUP_CEILING exactly: not one millisecond sooner, and not later.
 *   2. THE YIELD. With a new worker already installing, the same page load hands over work that ends at once: the
 *      top-up gives way before it asks for a single file.
 *
 * Planted: SWTOPUP_PLANT=ceiling serves the navigation's waitUntil(topUp()) with no ceiling (1 goes red: the work
 * never ends); SWTOPUP_PLANT=yield serves topUp() that never gives way (2 goes red: it waits for the ceiling).
 *
 *   node scripts/sw_topup_test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let SW = fs.readFileSync(path.join(REPO, "public/sw.js"), "utf8");
const PLANT = process.env.SWTOPUP_PLANT || "";
if (PLANT === "ceiling") {
  const t = SW.replace("e.waitUntil(Promise.race([topUp(), new Promise((ok) => setTimeout(ok, TOPUP_CEILING))]));", "e.waitUntil(topUp());");
  if (t === SW) throw new Error("the ceiling plant changed nothing"); SW = t;
} else if (PLANT === "yield") {
  const t = SW.replace("async function topUp(stop = updateWaiting) {", "async function topUp(stop = () => false) {");
  if (t === SW) throw new Error("the yield plant changed nothing"); SW = t;
} else if (PLANT) throw new Error(`no such plant: ${PLANT}`);
const CEILING = Number((/^const TOPUP_CEILING = (\d+);/m.exec(SW) || [])[1]);
const MARKER = (/^const APP_MARKER = '([^']+)';/m.exec(SW) || [])[1];
if (!CEILING || !MARKER) throw new Error("could not read TOPUP_CEILING and APP_MARKER out of public/sw.js");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "   -> " + detail : ""}`); }
};
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 50; i++) await tick(); };

/** sw.js in a scope of its own: its clock, its caches (empty), its network (the app's page answers; every other
 *  file is held), its registration (`waiting`/`installing` as given). */
function worker({ installing = null } = {}) {
  let now = 0, seq = 0;
  const timers = new Map();
  const handlers = {};
  const asked = [];
  const WORKER_AT = "https://worker.invalid";   // the worker's own address: nothing is ever fetched from it
  const emptyCache = { match: async () => undefined, put: async () => {}, keys: async () => [], delete: async () => false };
  const scope = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout: (fn, ms = 0) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0, clearInterval: () => {},
    URL, Request, Response, Headers, AbortController, AbortSignal, TextEncoder, TextDecoder, Blob, structuredClone,
    location: new URL(WORKER_AT + "/sw.js"),
    importScripts: () => {},
    registration: { waiting: null, installing, active: {}, scope: WORKER_AT + "/", showNotification: async () => {} },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => null },
    skipWaiting: async () => {},
    navigator: { onLine: true, storage: { estimate: async () => ({ quota: 1e10, usage: 0 }), persist: async () => true } },
    caches: { open: async () => emptyCache, match: async () => undefined, keys: async () => [], delete: async () => true, has: async () => false },
    fetch: (req) => {
      const u = new URL(typeof req === "string" ? req : req.url, WORKER_AT);
      asked.push(u.pathname);
      if (u.pathname === "/") return Promise.resolve(new Response(`<!doctype html><html ${MARKER}"><body></body></html>`, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }));
      return new Promise(() => {});
    },
    addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
  };
  scope.self = scope;
  vm.runInNewContext(SW, scope, { filename: "public/sw.js" });
  return {
    asked,
    get now() { return now; },
    /** The clock to `t`, each timer when it falls due, the page's promises run between. */
    async to(t) {
      for (;;) {
        await settle();
        const due = [...timers.entries()].filter(([, v]) => v.at <= t).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn();
      }
      now = t; await settle();
    },
    /** A page load of "/", as the browser sends it: what the worker answered, and the work it handed over. */
    navigate() {
      const held = [];
      let answer = null;
      const e = {
        request: { url: WORKER_AT + "/", method: "GET", mode: "navigate", headers: new Headers(), signal: new AbortController().signal },
        respondWith: (p) => { answer = p; },
        waitUntil: (p) => { const w = { done: false }; held.push(w); Promise.resolve(p).then(() => { w.done = true; }, () => { w.done = true; }); },
      };
      for (const h of handlers.fetch || []) h(e);
      return { held, get answer() { return answer; } };
    },
  };
}

console.log(`sw.js top-up${PLANT ? ` (PLANTED: ${PLANT})` : ""}, TOPUP_CEILING ${CEILING} ms`);

// 1. THE CEILING
{
  const w = worker();
  const nav = w.navigate();
  await w.to(0);
  const answered = nav.answer ? await Promise.race([nav.answer.then((r) => r && r.status), new Promise((r) => setTimeout(r, 200, "no answer"))]) : "no answer";
  const shellAsked = w.asked.filter((p) => p !== "/").length;
  await w.to(CEILING - 1);
  const before = nav.held.some((x) => !x.done);
  await w.to(CEILING);
  const at = nav.held.length && nav.held.every((x) => x.done);
  if (!at) await w.to(CEILING * 10);
  // Two pieces: the page's own request (net, kept alive past the answer) and, once it is the app's page, the top-up.
  check("1. the page is answered, and its load starts the top-up (files asked for, every one held)", answered === 200 && nav.held.length === 2 && shellAsked > 0,
    `answer ${answered}, ${nav.held.length} piece(s) of work handed over, ${shellAsked} file(s) asked for`);
  check(`1. with every file held, the work the page load handed over ends at TOPUP_CEILING (${CEILING} ms), not before`, before && at,
    `still running at ${CEILING - 1} ms: ${before}; ended by ${CEILING} ms: ${at}${at ? "" : `; by ${CEILING * 10} ms: ${nav.held.every((x) => x.done)}`}`);
}

// 2. THE YIELD
{
  const w = worker({ installing: { state: "installed" } });
  const nav = w.navigate();
  await w.to(0);
  const done0 = nav.held.length === 2 && nav.held.every((x) => x.done);
  const shellAsked = w.asked.filter((p) => p !== "/").length;
  check("2. a new worker installing: the page load's top-up gives way at once, before asking for a single file", done0 && shellAsked === 0,
    `ended at 0 ms: ${done0} (${nav.held.map((x) => x.done).join(",")}); files asked for: ${shellAsked}`);
}

console.log(`\n${pass} passed, ${fail} failed${PLANT ? ` (PLANTED: ${PLANT})` : ""}`);
process.exit(fail ? 1 : 0);
