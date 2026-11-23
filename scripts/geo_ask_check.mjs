#!/usr/bin/env node
/* THE LOCATION QUESTION IS THE PERSON'S TO ASK (21 Nov: on the installed app's first open the Itinerary raised iOS's
 * "Would Like to Use Your Location" over a dimmed page: the app never raises it by itself). The
 * gate's made-up trip, its host, 390 x 844, with a stand-in for the browser's location (navigator.geolocation and the
 * permission it reports, set before each page loads) that counts every read and watch:
 *
 *   A. A person whose browser hasn't been asked: the first open of every screen (the Itinerary, a plan, Places, a place,
 *      the map, Split, Photos, Chat, More) reads no location and starts no watch.
 *   B. The Itinerary offers one quiet row, "Show distance from me"; its tap is the one read; with a yes the distances
 *      show and the row goes; once the browser says granted, every later open reads by itself and shows no row.
 *   C. With a no, the row goes and stays gone on that phone (kept), Places' "Use my location" too, and a later open
 *      reads nothing, even where the browser would ask again.
 *   D. The map's locate button, tapped while refused, says in words why and where it's turned on.
 *
 * Planted: GEO_PLANT=loud serves agenda.js with its opening reads asking again (A goes red on the Itinerary, and B finds no
 * row: the planted read already holds a fix); GEO_PLANT=tight serves places.js with "Use my location" 6 px under the chips,
 * as it was (Places' reach check goes red: the button's reach covers the last chips').
 *
 *   node scripts/gate.mjs --only geo_ask_check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, boot, evalIn, waitFor, sleep, appSettled, signInAs } from "./lib/standalone_cdp.mjs";
import { tripPath, tripApi, HOST } from "./lib/gate_trip.mjs";

const PLANT = process.env.GEO_PLANT || "";
if (PLANT && PLANT !== "loud" && PLANT !== "tight") throw new Error(`no such plant: ${PLANT}`);
let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 200) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 600) : ""}`); }
}

// The stand-in, before the app's first line: what the browser says (perm) and answers (yes/no) come from
// sessionStorage["geo.double"], which this check writes; every read and watch is counted on window.__geo.
const DOUBLE = `(() => {
  let cfg = { perm: "prompt", answer: "yes" };
  try { cfg = { ...cfg, ...JSON.parse(sessionStorage.getItem("geo.double") || "{}") }; } catch {}
  window.__geo = { reads: 0, watches: 0 };
  const fix = () => ({ coords: { latitude: -13.1631, longitude: -72.5450, accuracy: 25 }, timestamp: Date.now() });
  const reply = (ok, err) => setTimeout(() => { if (cfg.answer === "yes") ok(fix()); else if (err) err({ code: 1, message: "User denied Geolocation" }); }, 40);
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition(ok, err) { window.__geo.reads++; reply(ok, err); },
    watchPosition(ok, err) { window.__geo.watches++; reply(ok, err); return 7; },
    clearWatch() {},
  } });
  if (navigator.permissions) {
    const q = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (d) => (d && d.name === "geolocation" ? Promise.resolve({ state: cfg.perm, onchange: null }) : q(d));
  }
})()`;

const b = await boot({ vw: 390, vh: 844, dsf: 1, reduceMotion: true });
const { cdp, S } = b;
const ev = (e) => evalIn(cdp, S, e);
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: DOUBLE }, S);
if (PLANT) {
  const file = PLANT === "loud" ? "agenda.js" : "places.js";
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), `../public/js/${file}`), "utf8");
  const t = PLANT === "loud" ? src.replaceAll("getPosition({ quiet: true })", "getPosition()")
    : src.replace(".pl-note{display:flex;align-items:center;gap:var(--sp-2);margin-top:14px;", ".pl-note{display:flex;align-items:center;gap:var(--sp-2);margin-top:6px;");
  if (t === src) throw new Error(`the ${PLANT} plant didn't take`);
  cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(t).toString("base64") }, S).catch(() => {}); });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/js/${file}*` }] }, S);
}
const counts = async () => JSON.parse(await ev(`JSON.stringify(window.__geo || { reads: -1, watches: -1 })`));
const setDouble = (cfg) => ev(`(sessionStorage.setItem("geo.double", ${JSON.stringify(JSON.stringify(cfg))}), 1)`);
const forgetHere = () => ev(`(localStorage.removeItem("wgp.pos"), localStorage.removeItem("wgp.pos.refused"), 1)`);
async function open(hash, ready) {
  await cdp.send("Page.navigate", { url: "about:blank" }, S);
  await sleep(60);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath(hash)}` }, S);
  await appSettled(cdp, S).catch(() => {});
  await waitFor(cdp, S, `(() => { const v = document.querySelector("#view"); return v && v.children.length && (${ready || "true"}) ? 1 : 0; })()`, { label: hash, timeout: 20000 });
  await sleep(1500);            // the quiet read and anything a screen asks after it settles
}
const ROW = `[...document.querySelectorAll("[data-loc-ask]")].filter((x) => x.getBoundingClientRect().height > 0)`;
// What a thumb finds: each target's reachable height, hit-tested outward in quarter pixels from its middle (as
// v5_verify_C does for the chips), so a reach that covers a neighbor's shows on the neighbor.
// With `near`, only the targets within 24 px above or below that element (its neighbors), not itself.
const REACH = (sel, near) => `JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].filter((b) => {
  const r = b.getBoundingClientRect(); if (!(r.height > 0)) return false;
  const n = ${near ? `document.querySelector(${JSON.stringify(near)})` : "null"}; if (!n) return ${near ? "false" : "true"};
  const m = n.getBoundingClientRect(); return b !== n && !n.contains(b) && r.top < m.bottom + 24 && r.bottom > m.top - 24;
}).map((b) => {
  const r = b.getBoundingClientRect(), cx = r.x + r.width / 2;
  // A chip scrolled out of its row's view isn't there to press: left out, not read as covered.
  if (cx < 1 || cx > innerWidth - 1) return null;
  const owns = (y) => { const e = document.elementFromPoint(cx, y); return !!(e && (e === b || b.contains(e))); };
  if (!owns(r.y + r.height / 2)) return { t: b.textContent.trim().slice(0, 20), h: 0 };
  let up = 0, dn = 0;
  for (let d = 0.25; d <= 24; d += 0.25) { if (owns(r.top - d)) up = d; else break; }
  for (let d = 0.25; d <= 24; d += 0.25) { if (owns(r.bottom + d)) dn = d; else break; }
  return { t: b.textContent.trim().slice(0, 20), h: r.height + up + dn };
}).filter(Boolean))`;
const reach = async (sel, near) => JSON.parse(await ev(REACH(sel, near)));
const lowest = (xs) => xs.reduce((m, x) => (x.h < m.h ? x : m), { t: "none", h: 99 });

try {
  await signInAs(cdp, S, HOST.key);
  await cdp.send("Page.navigate", { url: `${BASE}${tripPath("#/")}` }, S);
  await appSettled(cdp, S).catch(() => {});
  const snap = JSON.parse(await ev(`fetch(${JSON.stringify(tripApi(""))}, { credentials: "same-origin" }).then((r) => r.text())`));
  const anEvent = (snap.events || []).find((e) => e.place_id) || (snap.events || [])[0], aPlace = (snap.places || [])[0];

  console.log("\nA. A browser that hasn't been asked: no screen reads the location by itself");
  await setDouble({ perm: "prompt", answer: "yes" });
  await forgetHere();
  const SCREENS = [["the Itinerary", "#/", `document.querySelector("#view .ag-day")`], ["a plan", anEvent && `#/e/${encodeURIComponent(anEvent.id)}`],
    ["Places", "#/places"], ["a place", aPlace && `#/p/${encodeURIComponent(aPlace.id)}`], ["the map", "#/places?view=map", `document.querySelector(".mp-root")`],
    ["Split", "#/split"], ["Photos", "#/memories"], ["Chat", "#/chat"], ["More", "#/settings"]];
  for (const [name, hash, ready] of SCREENS) {
    if (!hash) { check(`${name}: the made-up trip has one`, false); continue; }
    await open(hash, ready);
    const c = await counts();
    check(`${name}: opened, no location read and no watch`, c.reads === 0 && c.watches === 0, JSON.stringify(c));
    if (name === "Places") {
      // "Use my location" shows here for a browser that hasn't been asked; its reach and the chips' above it both stay 44.
      const btn = await reach('#view .pl-note [data-act="locate"]'), chips = lowest(await reach("#view .pl-head .chip"));
      check(`Places: "Use my location" shows, reachable 44 px, and every chip above it still reaches 44`,
        btn.length === 1 && btn[0].h >= 44 - 0.6 && chips.h >= 44 - 0.6, `button ${JSON.stringify(btn)}, lowest chip ${JSON.stringify(chips)}`);
    }
  }

  console.log("\nB. The person asks, from the Itinerary's one quiet row");
  await open("#/", `document.querySelector("#view .ag-day")`);
  const row = JSON.parse(await ev(`JSON.stringify(${ROW}.map((x) => ({ text: x.textContent.trim(), h: Math.round(x.getBoundingClientRect().height) })))`));
  const slot = await ev(`JSON.stringify({ any: document.querySelectorAll("[data-loc-ask]").length, lede: (document.querySelector(".ag-ledeslot") || {}).innerHTML?.slice(0, 200), pos: localStorage.getItem("wgp.pos"), refused: localStorage.getItem("wgp.pos.refused") })`);
  check(`the Itinerary offers one row, "Show distance from me", 44 px to press`, row.length === 1 && row[0].text === "Show distance from me" && row[0].h >= 44, JSON.stringify(row) + " " + slot);
  if (!row.length) throw new Error("no row to press: " + slot);
  const rowReach = await reach("[data-loc-ask]"), near = lowest(await reach('#view a, #view button, #view [role="button"]', "[data-loc-ask]"));
  check("the row reaches 44 px and takes none from the targets around it", rowReach.length === 1 && rowReach[0].h >= 44 - 0.6 && near.h >= 44 - 0.6,
    `row ${JSON.stringify(rowReach)}, lowest neighbor ${JSON.stringify(near)}`);
  await ev(`(${ROW}[0].click(), 1)`);
  await waitFor(cdp, S, `(window.__geo.reads > 0 && !${ROW}.length) ? 1 : 0`, { label: "the row's read", timeout: 8000 }).catch(() => {});
  await sleep(800);
  const after = JSON.parse(await ev(`JSON.stringify({ geo: window.__geo, row: ${ROW}.length, dist: document.querySelectorAll("#view .ag-dist").length, kept: !!localStorage.getItem("wgp.pos") })`));
  check("its tap is the one read; with a yes the row goes and distances show", after.geo.reads === 1 && after.geo.watches === 0 && after.row === 0 && after.dist > 0 && after.kept, JSON.stringify(after));
  await setDouble({ perm: "granted", answer: "yes" });
  await ev(`(localStorage.removeItem("wgp.pos"), 1)`);
  await open("#/", `document.querySelector("#view .ag-day")`);
  const granted = JSON.parse(await ev(`JSON.stringify({ geo: window.__geo, row: ${ROW}.length, dist: document.querySelectorAll("#view .ag-dist").length })`));
  check("once the browser says granted, a later open reads by itself and shows distances with no row", granted.geo.reads === 1 && granted.row === 0 && granted.dist > 0, JSON.stringify(granted));

  console.log("\nC. The person says no: the app never asks again by itself");
  await setDouble({ perm: "prompt", answer: "no" });
  await forgetHere();
  await open("#/", `document.querySelector("#view .ag-day")`);
  await ev(`(${ROW}[0] && ${ROW}[0].click(), 1)`);
  await sleep(1200);
  const refused = JSON.parse(await ev(`JSON.stringify({ geo: window.__geo, row: ${ROW}.length, kept: localStorage.getItem("wgp.pos.refused") })`));
  check("a no: one read, the row goes, and the refusal is kept on this phone", refused.geo.reads === 1 && refused.row === 0 && refused.kept === "1", JSON.stringify(refused));
  await open("#/", `document.querySelector("#view .ag-day")`);
  const later = JSON.parse(await ev(`JSON.stringify({ geo: window.__geo, row: ${ROW}.length })`));
  check("a later open, where the browser would ask again: no read, no row", later.geo.reads === 0 && later.geo.watches === 0 && later.row === 0, JSON.stringify(later));
  await open("#/places");
  const places = JSON.parse(await ev(`JSON.stringify({ geo: window.__geo, locate: [...document.querySelectorAll('#view [data-act="locate"]')].filter((x) => x.getBoundingClientRect().height > 0).length })`));
  check(`Places: no read, and no "Use my location" after the no`, places.geo.reads === 0 && places.locate === 0, JSON.stringify(places));

  console.log("\nD. The map's locate button, tapped while refused, says why in words");
  await setDouble({ perm: "denied", answer: "no" });
  await open("#/places?view=map", `document.querySelector('.mp-root [data-act="geo"]')`);
  const opened = await counts();
  check("the map opened with the browser saying denied: no read, no watch", opened.reads === 0 && opened.watches === 0, JSON.stringify(opened));
  await ev(`(document.querySelector('.mp-root [data-act="geo"]').click(), 1)`);
  await sleep(900);
  const said = await ev(`(document.getElementById("toast") || {}).textContent || ""`);
  check("tapped: it says location is off for this site and where to turn it on", /Location is off for this site/.test(said) && /browser's settings/.test(said), said.slice(0, 160));
} catch (e) {
  fail++; failures.push(`threw: ${e.message}`); console.log(`  FAIL  threw: ${e.stack || e}`);
} finally {
  try { await ev(`(sessionStorage.removeItem("geo.double"), localStorage.removeItem("wgp.pos"), localStorage.removeItem("wgp.pos.refused"), 1)`); } catch {}
  await b.done().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log(`  FAILED  ${f}`); process.exit(1); }
