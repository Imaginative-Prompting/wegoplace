#!/usr/bin/env node
/* WHERE A TALL DRAWER SETTLES (sheet.js tallFor): the height a drag aims at is the [data-tall] rule's own (styles.css:
 * calc(100% - var(--safe-top) - var(--sp-3))), the status-bar band included. It used to parse --safe-top's text with
 * parseFloat, read NaN (the text is a calc()) and use 0, so on a phone with a top inset the drag aimed past the band
 * and snapped at the end. The gate's made-up trip, its host, 390 x 844, an app window, the top inset planted:
 *
 *   1. At an inset of 62 (a phone): what tallFor() gives equals the tall drawer's rendered height, and that height
 *      clears the band: its top sits --sp-3 below the inset.
 *   2. At an inset of 0 (a desktop browser): the same.
 *
 * Planted: TALL_PLANT=parse serves sheet.js with the old parse (1 goes red: 62 px apart).
 *
 *   node scripts/gate.mjs --only sheet_tall_check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, boot, evalIn, waitFor, sleep, appSettled, signInAs } from "./lib/standalone_cdp.mjs";
import { tripPath, HOST } from "./lib/gate_trip.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLANT = process.env.TALL_PLANT || "";
if (PLANT && PLANT !== "parse") throw new Error(`no such plant: ${PLANT}`);
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 200) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 600) : ""}`); }
}

const b = await boot({ vw: 390, vh: 844, dsf: 1, reduceMotion: true });
const { cdp, S } = b;
const ev = (e) => evalIn(cdp, S, e);
if (PLANT === "parse") {
  const src = fs.readFileSync(path.join(HERE, "../public/js/sheet.js"), "utf8");
  const t = src.replace(/export function tallFor\(root\) \{[\s\S]*?\n\}/, `export function tallFor(root) {
  const cs = getComputedStyle(root);
  const px = (n, fb) => parseFloat(cs.getPropertyValue(n)) || fb;
  return Math.max(0, root.clientHeight - px("--safe-top", 0) - px("--sp-3", 12));
}`);
  if (t === src) throw new Error("the parse plant didn't take");
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(t).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/sheet.js*" }] }, S);
}
// A drawer opened the app's way, held tall, measured; then what tallFor() says for its root.
const MEASURE = `import("/js/sheet.js").then(async (m) => {
  const body = document.createElement("div"); body.textContent = "A drawer, held tall.";
  const sh = m.openSheet({ title: "Tall", contentEl: body });
  await new Promise((r) => setTimeout(r, 600));
  const root = [...document.querySelectorAll(".sh-root")].pop();
  root.dataset.tall = "1";
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const sheet = root.querySelector(".sh-sheet"), r = sheet.getBoundingClientRect();
  const sp3 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sp-3")) || 12;
  const out = { rule: Math.round(r.height * 100) / 100, top: Math.round(r.top * 100) / 100, aim: Math.round(m.tallFor(root) * 100) / 100, sp3 };
  try { (sh && sh.close) ? sh.close() : root.remove(); } catch { root.remove(); }
  return JSON.stringify(out);
})`;

try {
  await signInAs(cdp, S, HOST.key);
  for (const top of [62, 0]) {
    await b.setInsets({ top, right: 0, bottom: 34, left: 0 }, "");
    await cdp.send("Page.navigate", { url: "about:blank" }, S);
    await sleep(60);
    await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
    await appSettled(cdp, S).catch(() => {});
    await waitFor(cdp, S, `document.querySelector("#view .ag-day") ? 1 : 0`, { label: "the Itinerary", timeout: 20000 });
    await sleep(800);
    const m = JSON.parse(await ev(MEASURE));
    console.log(`\nat a top inset of ${top}: ${JSON.stringify(m)}`);
    check(`inset ${top}: the drag aims at the tall drawer's own height (within a pixel)`, Math.abs(m.aim - m.rule) <= 1, JSON.stringify(m));
    check(`inset ${top}: that height clears the band (its top --sp-3 below the inset)`, Math.abs(m.top - (top + m.sp3)) <= 1, JSON.stringify(m));
  }
} catch (e) {
  fail++; failures.push(`threw: ${e.message}`); console.log(`  FAIL  threw: ${e.stack || e}`);
} finally {
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  FAILED  ${f}`); process.exit(1); }
