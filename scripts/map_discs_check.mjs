#!/usr/bin/env node
/* The marks on the map of a full trip: no disc stands on a disc or on a pin, and a region's
 * name is not under its own marks. In a real browser, on the gate's server and its made-up
 * trip, which is as dense as a trip gets (hundreds of places in one region).
 *
 *   node scripts/gate.mjs --only map_discs_check
 *   WGP_SHOTS=<folder> also writes pictures to look at. Nothing is asserted from them.
 *
 * WHY: places near each other are drawn as one disc with their count (public/js/map.js,
 * buildGroups). The rule that groups them asks how far apart two places are, and a disc is
 * wider than that distance: on a full trip the first thing the map showed was discs heaped
 * on each other, counts cut in half, and the region's name under two of them. settle() in
 * map.js is the second pass that takes in whatever a disc would stand on; nameSpot() writes
 * the name where nothing stands.
 *
 * WHAT IT PROVES, at 390 and at 320 wide, with nothing selected and no fan open:
 *   0. WITH THE PANEL OPEN, as the map first shows: the same, and the region's name is not
 *      under the map's own scale or buttons either.
 *   1. THE MAP WITH ITS PANEL SHUT: no disc's box reaches another disc's or a pin's; the discs' counts
 *      and the pins add up to every place that is on the screen (the second pass loses
 *      nobody); the region's name is written, in a spot the map calls clear, and no disc or
 *      pin is over it.
 *   2. THREE MORE ZOOMS: one and a half zooms in on the fullest disc, the same again, then
 *      street zoom on the place with the most neighbors. The same, measured again.
 *   3. A TAP ON THE FULLEST DISC still opens it: the camera goes in and its places are more
 *      than one mark (the map asks "would zooming split this?" with the same second pass).
 * The selected pin and an open fan are drawn above what is under them on purpose, and are
 * not measured here.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { BASE, appSettled, boot, evalIn, sleep, waitFor } from "./lib/standalone_cdp.mjs";
import { tripPath } from "./lib/gate_trip.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// Everything the page is asked, in one expression: the boxes of every disc and pin, the
// pairs that touch, the region names as the map last wrote them (moved from the canvas's
// own frame to the window's), and which marks are over a name.
const MEASURE = `(() => {
  const rect = (n) => { const r = n.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
  const discs = [...document.querySelectorAll(".mp-cluster")].map((n) => ({ kind: "disc", n: Number(n.querySelector(".mp-cluster-body").textContent), ids: (n.dataset.ids || "").split(",").length, box: rect(n.querySelector(".mp-cluster-body")) }));
  const pins = [...document.querySelectorAll(".mp-pin")].map((n) => ({ kind: "pin", on: n.dataset.on === "1", box: rect(n.querySelector(".mp-pin-body")) }));
  const marks = discs.concat(pins);
  const over = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;
  const touching = [];
  for (let i = 0; i < discs.length; i++) for (let j = 0; j < marks.length; j++) {
    if (j <= i && marks[j].kind === "disc") continue;
    if (marks[j] === discs[i] || !over(discs[i].box, marks[j].box)) continue;
    const a = discs[i].box, b = marks[j].box;
    touching.push({ a: "disc " + discs[i].n, b: marks[j].kind + (marks[j].n ? " " + marks[j].n : ""), by: [Math.round(Math.min(a.r, b.r) - Math.max(a.l, b.l)), Math.round(Math.min(a.b, b.b) - Math.max(a.t, b.t))] });
  }
  const canvas = document.querySelector(".mp-root canvas");
  const c = canvas.getBoundingClientRect();
  const names = (window.__wgpMapView.regionNames() || []).map((n) => {
    const box = { l: c.left + n.x, r: c.left + n.x + n.w, t: c.top + n.y, b: c.top + n.y + n.h };
    const furniture = [...document.querySelectorAll(".mp-root .mp-scale, .mp-root .mp-ctrls")].map(rect).filter((r) => r.r > r.l && over(box, r)).length;
    return { name: n.name, clear: n.clear, box, furniture, under: marks.filter((m) => over(box, m.box)).map((m) => m.kind + (m.n ? " " + m.n : "")) };
  });
  const cam = window.__wgpMapView.cam();
  // The places the map has a mark for: those on the surface, and a little way off each edge.
  const OFF = 90;
  const onScreen = (window.__discPlaces || []).filter((p) => { const s = window.__wgpMapView.project(p.lng, p.lat);
    return s.x >= -OFF && s.x <= c.width + OFF && s.y >= -OFF && s.y <= c.height + OFF; }).length;
  const big = discs.slice().sort((x, y) => y.n - x.n)[0] || null;
  return JSON.stringify({
    zoom: Math.round(cam.zoom * 100) / 100, cam: { lng: cam.lng, lat: cam.lat, zoom: cam.zoom, bearing: 0, pitch: 0 }, engine: window.__wgpMapView.engine(),
    discs: discs.length, pins: pins.length, selected: pins.filter((p) => p.on).length,
    counted: discs.reduce((s, d) => s + d.n, 0) + pins.length, onScreen, idsAgree: discs.every((d) => d.n === d.ids),
    touching, names,
    big: big ? { n: big.n, x: (big.box.l + big.box.r) / 2, y: (big.box.t + big.box.b) / 2 } : null,
    fan: !!document.querySelector(".mp-hub:not([hidden])"),
  });
})()`;

async function run(vw, vh) {
  section(`${vw} wide`);
  const b = await boot({ vw, vh, dsf: 2, reduceMotion: true });
  const { cdp, S } = b;
  const page = (expr) => evalIn(cdp, S, expr);
  const measure = async () => JSON.parse(await page(MEASURE));
  const look = async (name) => { if (SHOTS) await b.shot(path.join(SHOTS, `${vw}-${name}.png`)); };
  const held = (m, where, { wantName }) => {
    check(`${where}: no disc stands on a disc or on a pin`, m.touching.length === 0,
      m.touching.length ? `${m.touching.length} pairs, e.g. ${JSON.stringify(m.touching.slice(0, 4))}` : `${m.discs} discs, ${m.pins} pins at zoom ${m.zoom}`);
    check(`${where}: a disc's count is the places it holds, and with the pins they are every place on the screen`, m.idsAgree && m.counted === m.onScreen, `${m.counted} marked, ${m.onScreen} on the screen`);
    if (wantName) check(`${where}: the region's name is written, where the map found room`, m.names.length >= 1 && m.names.every((n) => n.clear), JSON.stringify(m.names.map((n) => [n.name, n.clear])));
    const covered = m.names.filter((n) => n.clear && (n.under.length || n.furniture));
    check(`${where}: no disc or pin is over a name the map calls clear, and it is not under the map's scale or buttons`, covered.length === 0, JSON.stringify(covered.map((n) => [n.name, n.under, n.furniture])));
  };
  try {
    await b.setInsets({ top: vw === 390 ? 47 : 20, right: 0, bottom: vw === 390 ? 34 : 0, left: 0 });
    await cdp.send("Page.navigate", { url: BASE + tripPath("#/places?view=map") }, S);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `document.querySelector("#view .mp-root") && document.querySelectorAll(".mp-cluster,.mp-pin").length > 3 && window.__wgpMapView ? 1 : 0`, { label: "the map with its marks", timeout: 40000 });
    // The panel open, as the map first shows: the scale rides above the panel, where the
    // name's spot under its plate would be.
    await sleep(1500);
    {
      const open = await measure();
      check("with the panel open: no disc stands on a disc or on a pin", open.touching.length === 0, JSON.stringify(open.touching.slice(0, 4)));
      const bad = open.names.filter((n) => n.under.length || n.furniture);
      check("with the panel open: the region's name, where it is written, is under no disc, pin, scale or button", bad.length === 0, JSON.stringify(open.names.map((n) => [n.name, n.clear, n.under, n.furniture])));
      if (vw === 390) check("…and at this width it is written", open.names.length >= 1, JSON.stringify(open.names));
      await look("panel-open");
    }
    // The panel shut: the whole surface is the map, as in the first picture anyone sees of it.
    await page(`(document.querySelector(".mp-grab") && document.querySelector('.mp-root:not([data-sheet="shut"])') ? (document.querySelector(".mp-grab").click(), 1) : 0)`);
    await waitFor(cdp, S, `document.querySelector('.mp-root[data-sheet="shut"]') ? 1 : 0`, { label: "the panel shut" });
    await sleep(1500);

    const placed = await page(`import("/js/store.js").then(({ store }) => { window.__discPlaces = store.places().filter((p) => p.lat != null && p.lng != null).map((p) => ({ id: p.id, lng: +p.lng, lat: +p.lat })); return window.__discPlaces.length; })`);
    let m = await measure();
    check("this is a full trip: hundreds of places with a position", placed >= 200, String(placed));
    check("nothing is selected and no fan is open", m.selected === 0 && !m.fan, JSON.stringify({ selected: m.selected, fan: m.fan }));
    check("as it opens: there are discs to measure, of a hundred places or more", m.discs >= 3 && m.onScreen >= 100, `${m.discs} discs, ${m.pins} pins, ${m.onScreen} places on the screen`);
    held(m, "as it opens", { wantName: true });
    await look("opens");

    // In on the fullest disc, twice: where the trip is thickest is where discs heap up. Then
    // street zoom on the place with the most others within a couple of hundred meters.
    const first = m;
    for (const [step, label] of [[1.5, "one and a half zooms in"], [1.5, "three zooms in"], [null, "street zoom"]]) {
      if (step != null && !m.big) { check(`${label}: there is a disc to go in on`, false, JSON.stringify(m)); break; }
      const to = await page(step != null
        ? `(() => { const v = window.__wgpMapView; const c = document.querySelector(".mp-root canvas").getBoundingClientRect();
            const at = v.unproject(${m.big ? m.big.x : 0} - c.left, ${m.big ? m.big.y : 0} - c.top);
            const to = { lng: at.lng, lat: at.lat, zoom: v.cam().zoom + ${step}, bearing: 0, pitch: 0 };
            v.jumpTo(to); return JSON.stringify(to); })()`
        : `(() => { const ps = window.__discPlaces; let best = null, most = -1;
            for (const p of ps) { let n = 0; for (const q of ps) if (Math.abs(q.lng - p.lng) < 0.002 && Math.abs(q.lat - p.lat) < 0.002) n++; if (n > most) { most = n; best = p; } }
            const to = { lng: best.lng, lat: best.lat, zoom: 16, bearing: 0, pitch: 0 };
            window.__wgpMapView.jumpTo(to); return JSON.stringify({ ...to, neighbors: most - 1 }); })()`);
      await sleep(1200);
      m = await measure();
      check(`${label}: the camera went there`, Math.abs(m.zoom - JSON.parse(to).zoom) < 0.05, `${m.zoom} for ${to}`);
      check(`${label}: there are marks to measure`, m.discs + m.pins >= 2, `${m.discs} discs, ${m.pins} pins`);
      held(m, label, { wantName: false });
      await look(label.replace(/ /g, "-"));
    }

    // Back out, and a tap on the fullest disc: the camera goes in and its places come apart.
    await page(`(window.__wgpMapView.jumpTo(${JSON.stringify(first.cam)}), 1)`);
    await sleep(1500);
    m = await measure();
    const before = m;
    check("back where it opened: the same marks as the first time", before.discs === first.discs && before.pins === first.pins, `${before.discs} discs and ${before.pins} pins, ${first.discs} and ${first.pins} the first time`);
    const tapped = await page(`(() => { const d = [...document.querySelectorAll(".mp-cluster")].sort((a, b) => b.dataset.ids.split(",").length - a.dataset.ids.split(",").length)[0];
      if (!d) return ""; window.__discIds = d.dataset.ids.split(","); d.click(); return String(window.__discIds.length); })()`);
    // Until the camera has stopped: the tap's flight is longer on a loaded machine, and a reading
    // taken mid-flight reads marks the settled map never shows.
    await sleep(1200);
    for (let i = 0, last = ""; i < 30; i++) {
      const cam = await page(`JSON.stringify(window.__wgpMapView.cam())`);
      if (cam === last) break;
      last = cam;
      await sleep(400);
    }
    await sleep(600);
    m = await measure();
    const parts = await page(`(() => { const ids = new Set(window.__discIds || []); let marks = 0;
      for (const n of document.querySelectorAll(".mp-cluster")) if ((n.dataset.ids || "").split(",").some((i) => ids.has(i))) marks++;
      for (const n of document.querySelectorAll(".mp-pin")) if (ids.has(n.dataset.id)) marks++;
      return marks; })()`);
    check("a tap on the fullest disc: the camera goes in", Number(tapped) > 4 && m.zoom > before.zoom + 0.05, `a disc of ${tapped}; zoom ${before.zoom} to ${m.zoom}`);
    check("…and its places are more than one mark there", parts > 1, `${parts} marks`);
    held(m, "after the tap", { wantName: false });
    await look("after-the-tap");

    check("no page error", b.pageErrors.length === 0, [...new Set(b.pageErrors)].join(" | "));
  } finally { await b.done(); }
}

try {
  await run(390, 844);
  await run(320, 640);
} catch (e) {
  fail++; failures.push("the check itself");
  console.log(`  FAIL  the check stopped: ${e && e.stack ? e.stack : e}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
process.exit(fail ? 1 : 0);
