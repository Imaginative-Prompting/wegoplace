#!/usr/bin/env node
/* EVERY SCREEN LOADS (20 Nov: Split said "This screen didn't load" on a preview: a name its "Goes with" rows used was
 * never imported, and no check opened Split on a trip that has those rows). The gate's made-up trip, its host, 390 x 844:
 * each of the app's screens opened once from its address, a fresh page each time: the Itinerary, a plan, Places, a
 * place, the map, Packing, Photos, Chat, the assistant, Split, a purchase, More, Changes, the credits. Each one mounts
 * (its route's view, not the shell's "This screen didn't load" or "This page didn't load") and throws nothing.
 *
 * Planted: SCREENS_PLANT=import serves split.js without catVars in its import from icons.js (Split red, and a purchase).
 *
 *   node scripts/gate.mjs --only screens_load_check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, boot, evalIn, waitFor, sleep, appSettled, signInAs } from "./lib/standalone_cdp.mjs";
import { tripPath, tripApi, HOST } from "./lib/gate_trip.mjs";

const PLANT = process.env.SCREENS_PLANT || "";
if (PLANT && PLANT !== "import") throw new Error(`no such plant: ${PLANT}`);
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 200) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 600) : ""}`); }
}

const b = await boot({ vw: 390, vh: 844, dsf: 1, reduceMotion: true });
const { cdp, S } = b;
const ev = (e) => evalIn(cdp, S, e);
if (PLANT) {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/js/split.js"), "utf8");
  const t = src.replace(/import \{ ([^}]*?), catVars \} from "\.\/icons\.js";/, 'import { $1 } from "./icons.js";');
  if (t === src) throw new Error("the import plant didn't take");
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(t).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/js/split.js*" }] }, S);
}
try {
  await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
  await signInAs(cdp, S, HOST.key);
  // A plan, a place and a purchase of the made-up trip, for their own pages.
  const api = (p) => ev(`fetch(${JSON.stringify(p)}, { credentials: "same-origin" }).then((r) => r.json()).then((j) => JSON.stringify(j))`).then((s) => JSON.parse(s));
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
  await appSettled(cdp, S).catch(() => {});
  const snap = await api(tripApi(""));
  const anEvent = (snap.events || [])[0], aPlace = (snap.places || [])[0];
  let aPurchase = (snap.purchases || [])[0];
  if (!aPurchase) { const p = await api(tripApi("/purchases")); aPurchase = (p.purchases || p.rows || [])[0]; }
  const SCREENS = [
    ["the Itinerary", "#/"], ["a plan", anEvent && `#/e/${encodeURIComponent(anEvent.id)}`], ["Places", "#/places"],
    ["a place", aPlace && `#/p/${encodeURIComponent(aPlace.id)}`], ["the map", "#/map"], ["Packing", "#/pack"], ["Photos", "#/memories"],
    ["Chat", "#/chat"], ["the assistant", "#/chat/assistant"], ["Split", "#/split"], ["a purchase", aPurchase && `#/split/${encodeURIComponent(aPurchase.id)}`],
    ["More", "#/settings"], ["Changes", "#/changes"], ["the credits", "#/settings/credits"],
  ];
  for (const [name, hash] of SCREENS) {
    if (!hash) { check(`${name}: the made-up trip has one to open`, false); continue; }
    const before = b.pageErrors.length;
    await cdp.send("Page.navigate", { url: "about:blank" }, S);
    await sleep(80);
    await cdp.send("Page.navigate", { url: `${BASE}${tripPath(hash)}` }, S);
    await appSettled(cdp, S).catch(() => {});
    let m = null;
    try {
      await waitFor(cdp, S, `(() => { const v = document.querySelector("#view"); return v && v.children.length && !/didn.t load/.test(v.textContent) && !document.querySelector("#view [aria-busy='true']") ? 1 : (/didn.t load/.test((v || {}).textContent || "") ? 1 : 0); })()`, { label: name, timeout: 20000 });
      await sleep(600);
      m = JSON.parse(await ev(`JSON.stringify({ failed: /didn.t load/.test(document.body.innerText), view: (document.querySelector("#view") || {}).children?.length || 0, hash: location.hash })`));
    } catch (e) { m = { failed: true, timeout: String(e.message).slice(0, 80) }; }
    const errors = b.pageErrors.slice(before);
    check(`${name} loads (${hash}): its screen, nothing thrown`, !m.failed && m.view > 0 && errors.length === 0, JSON.stringify({ ...m, errors: errors.join(" | ").slice(0, 300) }));
  }
} catch (e) {
  fail++; failures.push(`threw: ${e.message}`); console.log(`  FAIL  threw: ${e.stack || e}`);
} finally {
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  FAILED  ${f}`); process.exit(1); }
