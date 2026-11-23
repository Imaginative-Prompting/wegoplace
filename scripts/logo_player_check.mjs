#!/usr/bin/env node
/* The sign-in page's moving wordmark (public/js/logo-player.js) in a browser, signed out.
 *
 *   node scripts/gate.mjs --only logo_player_check
 *
 * The still wordmark is /img/wordmark.svg as it is; the loop's frames cut each hiker's gap with a mask, so a
 * wordmark with masks in it is the loop playing and one without is the still.
 * It holds:
 *   1. IT PLAYS: on sign-in the wordmark changes frame by frame (two looks 400 ms apart differ), drawn with the
 *      loop's masks, after the loop and the letters were fetched (/logo/idle-60.json, /logo/wordmark-data.json).
 *   2. REDUCED MOTION, TURNED ON WHILE IT PLAYS: it goes back to the still, and stays still.
 *   3. REDUCED MOTION FROM THE START: the still, unchanged over two seconds, and nothing under /logo/ fetched.
 *   4. ONLY SIGN-IN: a trip's page fetches nothing under /logo/ and never loads the player.
 *
 * PLANTED (LOGOP_PLANT=<name>, served in place of public/js/logo-player.js):
 *   noreduce  the player blind to reduced motion: 2 and 3 red.
 */
import { BASE, boot, evalIn, waitFor, sleep, appSettled } from "./lib/standalone_cdp.mjs";
import { tripPath, signedIn } from "./lib/gate_trip.mjs";
import fs from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

const PLANT = process.env.LOGOP_PLANT || "";
if (PLANT && PLANT !== "noreduce") throw new Error(`no such plant: ${PLANT}`);
const PLANTED = PLANT ? (() => {
  const src = fs.readFileSync(new URL("../public/js/logo-player.js", import.meta.url), "utf8");
  const t = src.replace('matchMedia("(prefers-reduced-motion: reduce)")', 'Object.assign(new EventTarget(), { matches: false })');
  if (t === src) throw new Error("the noreduce plant didn't take");
  return t;
})() : null;

const b = await boot({ vw: 390, vh: 844, dsf: 2, reduceMotion: false });
const { cdp, S } = b;
const J = async (e) => JSON.parse(await evalIn(cdp, S, e));
const asked = [];
cdp.on((m) => { if (m.sessionId === S && m.method === "Network.requestWillBeSent") asked.push(new URL(m.params.request.url).pathname); });
if (PLANTED) {
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/logo-player.js*" }] }, S);
}
const motion = (reduce) => cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] }, S);
const LOOK = `JSON.stringify((() => { const s = document.querySelector("#brand svg"); return s ? { masks: s.querySelectorAll("mask").length, paths: s.querySelectorAll("path").length, len: s.innerHTML.length, sum: [...s.innerHTML].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) } : null; })())`;
const signInPage = async () => {
  asked.length = 0;
  await cdp.send("Page.navigate", { url: `${BASE}/login` }, S);
  await waitFor(cdp, S, `document.querySelector("#brand svg") && !document.getElementById("page").hasAttribute("data-wait") ? 1 : 0`, { label: "sign-in", timeout: 30000 });
};

try {
  await cdp.send("Network.clearBrowserCookies", {}, S);

  section("1. It plays");
  await motion(false);
  await signInPage();
  await waitFor(cdp, S, `document.querySelectorAll("#brand svg mask").length ? 1 : 0`, { label: "the loop's first frame", timeout: 15000 }).catch(() => {});
  const a = await J(LOOK);
  await sleep(400);
  const b2 = await J(LOOK);
  check("the wordmark moves: drawn with the loop's masks, and two looks 400 ms apart differ", a && b2 && a.masks > 0 && b2.masks > 0 && a.sum !== b2.sum, JSON.stringify({ a, b: b2 }));
  check("the loop and the letters were fetched", asked.includes("/logo/idle-60.json") && asked.includes("/logo/wordmark-data.json"), asked.filter((p) => p.startsWith("/logo/")).join(", "));

  section("2. Reduced motion, turned on while it plays");
  await motion(true);
  await sleep(300);
  const c1 = await J(LOOK);
  await sleep(800);
  const c2 = await J(LOOK);
  check("it goes back to the still (no masks) and stays still", c1 && c2 && c1.masks === 0 && c1.sum === c2.sum, JSON.stringify({ c1, c2 }));

  section("3. Reduced motion from the start");
  await signInPage();
  await sleep(400);
  const d1 = await J(LOOK);
  await sleep(2000);
  const d2 = await J(LOOK);
  check("the still, unchanged over two seconds", d1 && d2 && d1.masks === 0 && d1.sum === d2.sum && d1.paths > 20, JSON.stringify({ d1, d2 }));
  check("nothing under /logo/ was fetched", !asked.some((p) => p.startsWith("/logo/")), asked.filter((p) => p.startsWith("/logo/")).join(", "));

  section("4. Only sign-in");
  // Away from sign-in first, so turning motion back on doesn't wake the player on the page being left.
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(300);
  await motion(false);
  for (const c of await signedIn()) await cdp.send("Network.setCookie", c, S);
  asked.length = 0;
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
  await appSettled(cdp, S);
  await waitFor(cdp, S, `document.querySelector("#view .ag-day, #view .empty") ? 1 : 0`, { label: "the trip", timeout: 30000 });
  await sleep(1500);
  check("a trip's page fetches nothing under /logo/ and never loads the player", !asked.some((p) => p.startsWith("/logo/") || p.endsWith("/logo-player.js") || p.endsWith("/hikers-player.js")),
    asked.filter((p) => /logo|hikers/.test(p)).join(", ") || `${asked.length} requests, none of them`);

  console.log(`\npage errors: ${b.pageErrors.length ? b.pageErrors.join(" | ").slice(0, 400) : "none"}`);
  check("no page errors", !b.pageErrors.length);
} finally {
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failed:\n" + failures.map((f) => "  FAIL  " + f).join("\n")); process.exit(1); }
