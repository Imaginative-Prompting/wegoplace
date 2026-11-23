#!/usr/bin/env node
/* NO NOTICE ABOUT REINSTALLING (21 Nov). A one-time card once asked an install from before to remove the app and add
 * it again, for the new top of the screen. The app tells the people using it nothing about its own updates, versions or
 * settings (AGENTS.md, "Never"), so the card is gone, and this holds that no such card or line shows, wherever the old
 * one would have. The gate's made-up trip, its host, 390 x 844, an app window, the top inset planted:
 *
 *   1. Installed, under the status bar (top inset 62, an install from before): no notice on the Itinerary.
 *   2. Installed, a new install (top inset 0): none.
 *   3. A browser tab: none.
 *   In each: no element of the old card ([data-reinstall-hint]), and no words on the screen about the Home Screen,
 *   reinstalling, updating the app or its versions.
 *
 * Planted: REINHINT_PLANT=shown serves agenda.js with a card like the old one in the Itinerary's opening lines (1-3 red).
 *
 *   node scripts/gate.mjs --only reinstall_hint_check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, boot, evalIn, waitFor, sleep, appSettled, signInAs } from "./lib/standalone_cdp.mjs";
import { tripPath, HOST } from "./lib/gate_trip.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLANT = process.env.REINHINT_PLANT || "";
if (PLANT && PLANT !== "shown") throw new Error(`no such plant: ${PLANT}`);
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 200) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 600) : ""}`); }
}

const b = await boot({ vw: 390, vh: 844, dsf: 1, reduceMotion: true });
const { cdp, S } = b;
const ev = (e) => evalIn(cdp, S, e);
// A browser tab, stood in for in this app window: Chrome's media emulation has no display-mode, so before the page's
// first line, matchMedia answers "(display-mode: standalone)" as a tab does, while sessionStorage["hint.tab"] says so.
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { if (sessionStorage.getItem("hint.tab") !== "1") return;
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => (/display-mode:\\s*standalone/.test(q) ? { matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } } : mm(q));
})()` }, S);
if (PLANT === "shown") {
  const src = fs.readFileSync(path.join(HERE, "../public/js/agenda.js"), "utf8");
  const t = src.replace("const lede = next.lede + locRowHtml();",
    "const lede = next.lede + '<div data-reinstall-hint><p>To get the new top of the screen, remove WeGoPlace from your Home Screen and add it again.</p></div>' + locRowHtml();");
  if (t === src) throw new Error("the shown plant didn't take");
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(t).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/agenda.js*" }] }, S);
}
// What a notice of that kind would be: the old card's element, or words about the app itself on the screen.
const NOTICE = `JSON.stringify((() => {
  const card = [...document.querySelectorAll("#view [data-reinstall-hint]")].filter((x) => x.getBoundingClientRect().height > 0).length;
  const words = (document.querySelector("#view") || document.body).innerText;
  const said = (words.match(/home screen|reinstall|add it again|update the app|new version|old setting/gi) || []);
  return { card, said: [...new Set(said.map((w) => w.toLowerCase()))] };
})())`;
async function open(top, display = "standalone") {
  await b.setInsets({ top, right: 0, bottom: 34, left: 0 }, "");
  await ev(`(sessionStorage.setItem("hint.tab", ${JSON.stringify(display === "browser" ? "1" : "0")}), localStorage.removeItem("wgp.reinstall.hint"), 1)`).catch(() => {});
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(60);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
  await appSettled(cdp, S).catch(() => {});
  await waitFor(cdp, S, `document.querySelector("#view .ag-day") ? 1 : 0`, { label: "the Itinerary", timeout: 20000 });
  await sleep(1200);
  return JSON.parse(await ev(NOTICE));
}

try {
  await signInAs(cdp, S, HOST.key);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
  await appSettled(cdp, S).catch(() => {});
  for (const [name, top, display] of [["installed, under the status bar (top inset 62)", 62, "standalone"], ["installed, a new install (top inset 0)", 0, "standalone"], ["a browser tab", 62, "browser"]]) {
    const n = await open(top, display);
    check(`${name}: no notice about the app itself on the Itinerary`, n.card === 0 && n.said.length === 0, JSON.stringify(n));
  }
} catch (e) {
  fail++; failures.push(`threw: ${e.message}`); console.log(`  FAIL  threw: ${e.stack || e}`);
} finally {
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  FAILED  ${f}`); process.exit(1); }
