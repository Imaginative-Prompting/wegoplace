#!/usr/bin/env node
/* Where the map puts the trip's places when it fits or zooms to them (public/js/map.js fitTo,
 * insets, cameraFor), on a server of its own with two made-up trips, read off the marks drawn:
 *
 *   1. CLEAR OF THE MAP'S OWN FURNITURE. A trip whose places fill the room a phone's map leaves
 *      (a grid, as tall for its width as that room, so its places reach the room's foot and right
 *      edge): on first open, after "Show all places" and after a place
 *      opened from the panel's list, no pin or disc lies under the three buttons, "Nearby", the
 *      scale or the +, at 320 and 390 (a safe area), with the panel shut and open. 15 Nov: with
 *      the panel shut a fit kept only 16 px at the foot, and a corner place could land under
 *      "Nearby" or the +. The same at the two short screens of the narrow measure (lib/narrow.mjs):
 *      320 x 568, the buttons in a column at the right, and 844 x 390 on its side, where they lie in
 *      a row at the map's foot and the fit keeps the whole width; there a second trip too, a row of
 *      places far wider than tall, so a fit by the width puts places at the room's right edge, next
 *      to the buttons, its top-right and bottom-right corners among them.
 *      And 667 x 375 on its side (no notch), the smallest strip of map a phone shows.
 *   2. ACROSS 180°. A trip on Taveuni, whose places lie either side of the 180° line: it opens
 *      with them in view, close, not stretched round the world; "Show all places" and a place
 *      opened from the list take the short way. At 390 and 1440.
 *   3. THE STRIP THE MAP SHOWS, between the page's head and the panel. On a short screen (no taller than 420) the panel
 *      opens at 150 px, and at 390 x 844 at 190 to 300 as before. At 844 x 390 and 667 x 375 with the panel open, every
 *      mark wholly in that strip on first open and after "Show all places" (19 Nov, 667 x 375: the places across the
 *      panel's top edge). A place's card, opened from the list or by tapping its pin low on the map: its pin wholly in
 *      view above the card, the map's buttons and scale below the head, and the + not on the card's "Place page".
 * And no page error.
 *
 *   node scripts/gate.mjs --only map_fit_check
 *
 * Its own server, no map archive: the map is the drawn ground, as on a trip whose map is still
 * being made, and the camera is the same either way.
 *
 * At 1024 and wider (two panes): the map beside Places' list is bare (no list of its own), and a place
 * reached by the anchor lands the short way with its row marked in the list.
 *
 * MAP_FIT_PLANT=rowfoot (the row always at the foot), rownowhere (kept clear nowhere), nostrip, nokeep, noroof, onadd
 * and panel190 (part 3's, one each): see below.
 *
 * PLANTED (red when put in by hand, 15 Nov): map.js insets() with the old bottom (the panel's
 * height only): a place at the grid's foot under the scale (and at 1440 a Taveuni place too);
 * the right inset as wide as the whole .mp-ctrls ("Nearby" in it when the panel is shut): the
 * places 30 px left of the middle;
 * fitTo() taking each place's own longitude, not the one nearest the others: Taveuni's map
 * never comes in (the long way round, at 1440 in two panes too);
 * map.js claim() with bare off (16 Nov): the map beside the list draws its own list again.
 */
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import path from "node:path";
import fs from "node:fs";

// WGP_SHOTS=<folder>: a still of each map as it was read (made-up trips only).
const SHOTS = process.env.WGP_SHOTS || "";

// Plants, each serving js/map.js changed:
//   MAP_FIT_PLANT=rowfoot     the scale and the buttons' row always kept clear below the places, even when that leaves a
//                             fit no room (as sw v113 had it): on its side with the panel open, places among them
//   MAP_FIT_PLANT=rownowhere  the row kept clear nowhere, neither at the foot nor beside: with the panel shut too
//   MAP_FIT_PLANT=nostrip     a short strip's points centred in a room of the fit's floor, not in the strip (as v114
//                             had it): at 667 x 375 with the panel open the places across the panel's edge
//   MAP_FIT_PLANT=nokeep      a pin tapped on the map opens its card where it stands: under the card on a short screen
//   MAP_FIT_PLANT=noroof      the map's buttons and scale ride above a card however tall: up under the head at 667 x 375
//   MAP_FIT_PLANT=onadd       the card's buttons take the panel's whole width: the + on "Place page" at 667 x 375
//   MAP_FIT_PLANT=panel190    no short screen's panel height: open at 190 there too
//   MAP_FIT_PLANT=card226     a place's card as tall on a short screen as anywhere: at 667 x 375 its picked pin, drawn
//                             at 1.15, is taller than the map left above the card (46 px), and stands up under the head
//   MAP_FIT_PLANT=cardunder   a place's card as tall with a pill over its foot as without: at 390 and 320 upright its
//                             buttons under the pill, and the + on its ✕
//   MAP_FIT_PLANT=pill        styles.css, not map.js: see PLANTED_FILE below
const PLANT = process.env.MAP_FIT_PLANT || "";
const PLANTS = {
  nostrip: [["if (!box.strip) return { x, y:", "if (true) return { x, y:"], ["const range = box.strip ? stripRange", "const range = false ? stripRange"]],
  nokeep: [["} else if (id) keepInView(placeById(id));", "}"]],
  noroof: [["`${Math.min(Math.max(S.sheetH, S.under) + 12, roof)}px`", "`${Math.max(S.sheetH, S.under) + 12}px`"]],
  onadd: [["if (need !== actsR) {", "need = 0; if (need !== actsR) {"]],
  panel190: [["@media (max-height: 420px) and (min-width: 480px){ .mp-sheet{height:calc(150px + var(--mp-dock))} }", ""]],
  card226: [["  .mp-root{--mp-card-h:207px}\n", ""]],
  cardunder: [["height:calc(var(--mp-card-h) + var(--mp-dock) + var(--mp-under, 0px))", "height:calc(var(--mp-card-h) + var(--mp-dock))"]],
};
if (PLANT && !["rowfoot", "rownowhere", "pill", ...Object.keys(PLANTS)].includes(PLANT)) throw new Error(`no such plant: ${PLANT}`);
// MAP_FIT_PLANT=pill serves styles.css (not js/map.js) with the rail from 768 only, as before 19 Nov: at 667 x 375 on its
// side the pill over the map's foot, the card's buttons under it and the + on the card's ✕.
const PLANTED_FILE = PLANT === "pill" ? "styles.css" : "js/map.js";
const PLANTED = PLANT === "pill" ? (() => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const t = css.replace(/, \(orientation: landscape\) and \(max-height: 420px\) and \(min-width: 480px\)( and \(max-width: 1023\.98px\))?/g, "")
    .replace(/\(max-width: 767\.98px\) and \(orientation: portrait\), \(max-width: 767\.98px\) and \(min-height: 420\.02px\), \(max-width: 479\.98px\)/g, "(max-width: 767.98px)");
  if (t === css || /@media[^{]*orientation: landscape/.test(t)) throw new Error("the pill plant didn't take");
  return t; })() : PLANT ? (() => {
  const js = fs.readFileSync(new URL("../public/js/map.js", import.meta.url), "utf8");
  if (PLANTS[PLANT]) {
    let t = js;
    for (const [from, to] of PLANTS[PLANT]) { if (!t.includes(from)) throw new Error(`the ${PLANT} plant didn't take: ${from}`); t = t.replace(from, to); }
    return t;
  }
  const rule = "if (S.h - top - below >= ROOM_FLOOR_PX) return";
  const t = PLANT === "rowfoot" ? js.replace(rule, "if (true) return")
    : js.replace(rule, "if (true) return").replace("Math.min(S.footTop ?? S.h, row ? (S.rowTop ?? S.h) : S.h)", "(S.footTop ?? S.h)")
      .replace("Math.max(scaleEl ? scaleEl.offsetHeight : 0, row ? btns.offsetHeight : 0)", "(scaleEl ? scaleEl.offsetHeight : 0)");
  if (t === js || (PLANT === "rownowhere" && t.includes("row ? btns.offsetHeight"))) throw new Error(`the ${PLANT} plant didn't take`);
  return t; })() : null;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 700) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

// A grid of made-up places, 3 across and 5 down, about as tall for its width as the room a phone's
// map leaves (so a fit fills that room to its corners, and places stand along its foot and right
// edge, where "Nearby", the + and the buttons are).
const NAMES = ["Gate", "Square", "Pier", "Lane", "Steps", "Arch", "Well", "Bridge", "Garden", "Tower", "Market", "Chapel", "Corner", "Yard", "Point"];
const CORNERS = [];
for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) {
  const i = row * 3 + col;
  CORNERS.push({ id: `g-${i}`, name: `The ${NAMES[i]}`, kind: "sight", subkind: "viewpoint", lat: -12.0 - row * 0.034, lng: -77.06 + col * 0.04 });
}
// The first one's address long enough for two lines on any phone (a place's card, part 3).
CORNERS[0].address = "1200 Made-up Avenue, between the Old Gate and the Long Steps, Corner Quarter, Made-up Province";
// Two rows of eight, about forty times as wide as tall: wider for its height than the room any phone's map leaves, so
// a fit is made by the width and the right-hand places stand at the room's right edge.
const ROWS = [];
for (let row = 0; row < 2; row++) for (let col = 0; col < 8; col++) {
  const i = row * 8 + col;
  ROWS.push({ id: `w-${i}`, name: `Stop ${i + 1}`, kind: "sight", subkind: "viewpoint", lat: -12.2 - row * 0.01, lng: -77.3 + col * 0.06 });
}
// Taveuni, Fiji: the 180° line crosses the island.
const TAVEUNI = [
  { id: "t-a", name: "Waterfall Path Start", kind: "sight", subkind: "viewpoint", lat: -16.810, lng: 179.975 },
  { id: "t-b", name: "Reef Bay Landing", kind: "sight", subkind: "beach", lat: -16.850, lng: -179.960 },
  { id: "t-c", name: "Village Market", kind: "food", subkind: "market", lat: -16.880, lng: 179.930 },
  { id: "t-d", name: "Point Lodge", kind: "lodging", subkind: "hotel", lat: -16.790, lng: -179.900 },
];

const server = await startServer({ name: "map-fit", port: await freeLoopbackPort() });
ownServer(server.origin);
const browsers = [];
try {
  await server.start();
  const ada = new Person(server.origin, "Ada Reyes");
  await ada.signUp();
  const tripOf = async (name, tz, places) => {
    const made = await ada.post("/api/trips", { name, default_tz: tz });
    const T = `/api/trips/${made.json.trip.id}`;
    const put = await ada.call("PUT", `${T}/places`, { places: places.map((p) => ({ ...p, why: "A made-up place." })) });
    if (made.status !== 201 || put.status >= 300) throw new Error(`trip ${name}: ${made.status} ${put.status} ${put.text}`);
    return made.json.trip.id;
  };
  const corner = await tripOf("Corner Walk", "America/Lima", CORNERS);
  const taveuni = await tripOf("Taveuni Days", "Pacific/Fiji", TAVEUNI);
  const rows = await tripOf("Coast Stops", "America/Lima", ROWS);
  check("three made-up trips: one filling the room, one far wider than tall, one across 180°", !!corner && !!rows && !!taveuni);

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");

  // What the map shows now: its camera, each mark's body, and the furniture over the map.
  const READ = `JSON.stringify((() => {
    const box = (n) => { const r = n.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
    const surf = box(document.querySelector("#view .mp-surface") || document.querySelector("#view .mp-root"));
    const chrome = [...document.querySelectorAll(".mp-ctrl, .mp-peek, .mp-scale, #rt-fixed .fab")]
      .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && getComputedStyle(n).display !== "none"; })
      .map((n) => ({ what: n.getAttribute("aria-label") || n.className.split(" ")[0], ...box(n) }));
    const marks = [...document.querySelectorAll(".mp-pin .mp-pin-body, .mp-cluster > *:first-child")]
      .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && getComputedStyle(n.closest(".mp-pin, .mp-cluster")).display !== "none"; })
      .map((n) => ({ what: (n.closest(".mp-pin, .mp-cluster").getAttribute("aria-label") || "").slice(0, 40), ...box(n) }));
    const hit = (a, c) => !(a.r <= c.l || a.l >= c.r || a.b <= c.t || a.t >= c.b);
    const under = [];
    for (const m of marks) for (const c of chrome) if (hit(m, c)) under.push(m.what + " under " + c.what);
    const inside = marks.filter((m) => m.l >= surf.l && m.r <= surf.r && m.t >= surf.t && m.b <= surf.b).length;
    // Across: the room a fit leaves (map.js's own numbers: 24 + 17 px at the left; at the right the
    // buttons' column, 24 + its width + 17, or none when they lie in a row at the foot), and where
    // the pins' points stand in it.
    const btns = document.querySelector(".mp-btns");
    const inRow = !!btns && getComputedStyle(btns).flexDirection === "row";
    const btnW = inRow ? 0 : Math.max(0, ...[...document.querySelectorAll(".mp-ctrl")].map((n) => n.offsetWidth));
    // The room map.js used, from its own debug handle where it has one (it keeps the buttons' row clear at the foot or
    // beside the places, by its own rule); else its numbers, as before.
    const ins = __wgpMapView.insets ? __wgpMapView.insets() : null;
    const room = ins ? { l: surf.l + ins.left, r: surf.r - ins.right } : { l: surf.l + 41, r: surf.r - (24 + btnW + 17) };
    // A pin's or a group's own box has no size: it stands at its point (the body is drawn above it).
    const pts = [...document.querySelectorAll(".mp-pin, .mp-cluster")].filter((n) => getComputedStyle(n).display !== "none").map((n) => n.getBoundingClientRect());
    const xs = pts.map((q) => q.left);
    const across = xs.length ? Math.round(((Math.min(...xs) + Math.max(...xs)) / 2 - (room.l + room.r) / 2) * 10) / 10 : null;
    // Where the map shows between the page's head and the panel, and the points' height in it, for a red to be read by.
    const sheet = document.querySelector("#view .mp-sheet");
    const shown = { t: Math.round(surf.t), b: Math.round(sheet && sheet.getBoundingClientRect().height ? Math.min(surf.b, sheet.getBoundingClientRect().top) : surf.b) };
    const ys = pts.map((q) => Math.round(q.top));
    return { cam: __wgpMapView.cam(), marks: marks.length, inside, under, across, room, inRow, shown, ys: ys.length ? [Math.min(...ys), Math.max(...ys)] : null, chrome: chrome.map((c) => c.what) };
  })())`;

  const { PHONES, setPhone, insetsHonest } = await import("./lib/narrow.mjs");
  const SIZES = [
    { vw: 320, vh: 640, phone: true, wrap: false },
    { vw: 390, vh: 844, inset: true, phone: true, wrap: true, strip: true },
    { vw: 1440, vh: 900, phone: false, wrap: true },
    // The narrow measure's own two short screens, their safe areas through Chrome's own override.
    { ...PHONES.find((p) => p.w === 320 && p.h === 568), phone: true, wrap: false, rows: true, strip: true },
    { ...PHONES.find((p) => p.w === 844 && p.h === 390), phone: true, wrap: false, rows: true, strip: true },
    // A smaller phone on its side, no notch: the map shows least here, and the + floats over the panel.
    { w: 667, h: 375, insets: { top: 0, right: 0, bottom: 0, left: 0 }, name: "667x375 on its side", phone: true, wrap: false, rows: true, strip: true },
  ];
  for (const sz of SIZES) {
    const vw = sz.vw || sz.w, vh = sz.vh || sz.h, inset = !!sz.inset;
    const b = await boot({ vw, vh, dsf: 1 });
    browsers.push(b);
    const { cdp, S } = b;
    if (PLANTED) {
      cdp.on((m) => { if (m.sessionId === S && m.method === "Fetch.requestPaused") cdp.send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: `${PLANTED_FILE.endsWith(".css") ? "text/css" : "text/javascript"}; charset=utf-8` }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(PLANTED).toString("base64") }, S).catch(() => {}); });
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `*/${PLANTED_FILE}*` }] }, S);
    }
    if (inset) await b.setInsets({ top: 47, right: 0, bottom: 34, left: 0 });
    if (sz.insets) await setPhone(cdp, S, sz);
    else await cdp.send("Emulation.setDeviceMetricsOverride", { width: vw, height: vh, deviceScaleFactor: 1, mobile: vw < 1000 }, S);
    const at = sz.name || String(vw);
    for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: ada.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
    const page = (e) => evalIn(cdp, S, e);
    const still = async (name) => { if (SHOTS) await b.shot(path.join(SHOTS, `${at.replace(/\W+/g, "-")}-${name}.png`)); };
    let n = 0;
    // The panel as a person last left it (map.js SHEET_KEY), written before the page's first script.
    let sheetScript = null;
    const open = async (trip, sheet) => {
      if (sheetScript) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: sheetScript }, S);
      // And no camera remembered from the last visit (map.js keeps one per trip for 12 hours,
      // "wgp.map.cam@<trip>"): every open here is a first open, fitted for the room it has.
      sheetScript = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("wgp.map.sheet", ${JSON.stringify(sheet)});
        for (const k of Object.keys(localStorage)) if (k.startsWith("wgp.map.cam")) localStorage.removeItem(k); } catch {}` }, S)).identifier;
      await cdp.send("Page.navigate", { url: "about:blank" }, S);
      await sleep(150);
      await cdp.send("Page.navigate", { url: `${server.origin}/t/${trip}/?n=${++n}#/places?view=map` }, S);
      await appSettled(cdp, S);
      await waitFor(cdp, S, `window.__wgpMapView && document.querySelectorAll(".mp-pin, .mp-cluster").length > 0 ? 1 : 0`, { label: "the map", timeout: 40000 });
      await sleep(2500);
      const shown = await page(`(document.querySelector("#view .mp-root") || { dataset: {} }).dataset.sheet || ""`);
      if (shown !== sheet) throw new Error(`the panel is ${shown}, not ${sheet}`);
    };
    const tapCtrl = async (label) => {
      const r = JSON.parse(await page(`JSON.stringify((() => { const n = document.querySelector('.mp-ctrl[aria-label="${label}"]'); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })())`));
      for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: r.x, y: r.y, button: "left", clickCount: 1 }, S);
      await sleep(1800);
    };
    const fromList = async (id) => {
      const ok = await page(`(() => { const a = document.querySelector('#view [data-pick="${id}"]'); if (!a) return 0; a.click(); return 1; })()`);
      await sleep(1800);
      return ok;
    };

    if (sz.phone) {
      section(`1. clear of the map's own furniture (${at}${inset || sz.insets ? ", a safe area" : ""})`);
      const trips = [["the grid", "grid", corner], ...(sz.rows ? [["the row of stops", "rows", rows]] : [])];
      for (const [what, tag, trip] of trips) for (const sheet of ["shut", "open"]) {
        await open(trip, sheet);
        if (sz.insets && tag === "grid" && sheet === "shut" && !(await insetsHonest(page, check, sz))) throw new Error("the safe-area emulation isn't honest");
        let r = JSON.parse(await page(READ));
        await still(`${tag}-${sheet}-open`);
        check(`${at}, ${what}, panel ${sheet}: on first open every place in view and none under the buttons, "Nearby", the scale or the +`, r.marks >= 1 && r.inside === r.marks && !r.under.length, JSON.stringify({ marks: r.marks, inside: r.inside, under: r.under, inRow: r.inRow, shown: r.shown, ys: r.ys, chrome: r.chrome }));
        check(`${at}, ${what}, panel ${sheet}: and across, in the middle of the room the buttons leave (not of a room as narrow as "Nearby" is wide)`, r.across !== null && Math.abs(r.across) <= 3, JSON.stringify({ off: r.across, room: r.room }));
        await tapCtrl("Show all places");
        r = JSON.parse(await page(READ));
        await still(`${tag}-${sheet}-show-all`);
        check(`${at}, ${what}, panel ${sheet}: after "Show all places", the same`, r.marks >= 1 && r.inside === r.marks && !r.under.length, JSON.stringify({ marks: r.marks, inside: r.inside, under: r.under }));
      }
    }
    if (sz.wrap) {
      section(`2. across 180° (${vw})`);
      await open(taveuni, "shut");
      let r = JSON.parse(await page(READ));
      await still("taveuni-open");
      check(`${vw}: Taveuni's places across, in the middle of the room the buttons leave`, r.across !== null && Math.abs(r.across) <= 3, JSON.stringify({ off: r.across, room: r.room }));
      const short = (c) => Math.abs(c.lng) > 179 && c.zoom >= 9;
      check(`${vw}: Taveuni opens on its places, close and the short way (camera at the 180° line, zoomed in), every place in view`, short(r.cam) && r.marks >= 1 && r.inside === r.marks && !r.under.length, JSON.stringify({ cam: { lng: +r.cam.lng.toFixed(3), lat: +r.cam.lat.toFixed(3), zoom: +r.cam.zoom.toFixed(2) }, marks: r.marks, inside: r.inside, under: r.under }));
      await page(`(__wgpMapView.jumpTo({ lng: 0, lat: 0, zoom: 2 }), 1)`);
      await sleep(600);
      await tapCtrl("Show all places");
      r = JSON.parse(await page(READ));
      check(`${vw}: "Show all places" from across the world comes back the short way`, short(r.cam) && r.inside === r.marks && !r.under.length, JSON.stringify({ cam: { lng: +r.cam.lng.toFixed(3), zoom: +r.cam.zoom.toFixed(2) }, marks: r.marks, inside: r.inside }));
      if (vw >= 1024) {
        // Two panes (router.js, the layouts (b)): the map beside Places' list is only the map, its own
        // list sheet not drawn (the list is the other pane; map.js "bare"); a place is opened from
        // pane A's row, as its page beside the list. So here: the panel stays shut, and no list of its own.
        const bare = JSON.parse(await page(`JSON.stringify((() => { const m = document.querySelector("#view .rt-pane-b .mp-root"); return { inPaneB: !!m, bare: !!m && m.dataset.bare === "1", sheet: m ? m.dataset.sheet : null, listRows: [...document.querySelectorAll("#view .rt-pane-b [data-pick]")].filter((n) => n.getClientRects().length).length }; })())`));
        check(`${vw}: two panes: the map beside the list is only the map (its panel shut, no list of its own)`, bare.inPaneB && bare.bare && bare.sheet === "shut" && bare.listRows === 0, JSON.stringify(bare));
        // How a desktop reaches a place on the map beside the list: the anchor (#/places?near=<place>,
        // as the Itinerary's "nearby" link arrives). The map lands on it the short way across 180°,
        // close in, and its row in pane A is marked (map.js onPick → places.js).
        await cdp.send("Page.navigate", { url: "about:blank" }, S);
        await sleep(150);
        await cdp.send("Page.navigate", { url: `${server.origin}/t/${taveuni}/?n=${++n}#/places?near=t-b` }, S);
        await appSettled(cdp, S);
        await waitFor(cdp, S, `window.__wgpMapView && document.querySelector("#view .rt-pane-b .mp-root") && document.querySelectorAll(".mp-pin, .mp-cluster").length > 0 ? 1 : 0`, { label: "the map beside the list, on the anchor", timeout: 40000 });
        await sleep(2500);
        r = JSON.parse(await page(READ));
        const head = await page(`((document.querySelector("#view .rt-pane-a .pl-anchor-n") || {}).textContent || "").trim()`);
        await still("taveuni-anchor-two-panes");
        // The anchor heads the list ("Near …"), not a row of it.
        check(`${vw}: a place reached from beside the list (east of 180°): the map lands on it the short way, close in, and the list is headed by it`,
          Math.abs(r.cam.lng) > 179 && r.cam.zoom >= 9 && r.inside >= 1 && !r.under.length && head === "Near Reef Bay Landing",
          JSON.stringify({ cam: { lng: +r.cam.lng.toFixed(3), zoom: +r.cam.zoom.toFixed(2) }, inside: r.inside, under: r.under, head }));
        // A pin tapped on the bare map (Waterfall Path Start, the far side of 180°) marks its row in the
        // list, and the mark stays through the list's own redraws (read after them).
        await tapCtrl("Show all places");          // the anchor's camera is close in on Reef Bay: all of Taveuni in view
        const pin = JSON.parse(await page(`JSON.stringify((() => { const p = document.querySelector('#view .rt-pane-b .mp-pin[data-id="t-a"]'); if (!p) return null; const q = p.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })())`));
        if (pin) for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: pin.x, y: pin.y, button: "left", clickCount: 1 }, S);
        await sleep(2500);
        const marked = await page(`(() => { const li = [...document.querySelectorAll("#view .rt-pane-a li[data-key]")].find((n) => n.dataset.key === "t-a"); const row = li && li.querySelector(".pl-row"); return row && row.dataset.on === "1" ? 1 : 0; })()`);
        // The list redrawn under it (the "Sights" chip: Waterfall Path Start is a sight, so it stays
        // in the list): the mark is put back on the new row.
        const redrew = await page(`(() => { const before = document.querySelector("#view .rt-pane-a .pl-lists").firstElementChild; const c = document.querySelector('#view .rt-pane-a .chip[data-kind="sight"]'); if (!c) return -1; c.click(); return 1; })()`);
        await sleep(2000);
        const kept = await page(`(() => { const li = [...document.querySelectorAll("#view .rt-pane-a li[data-key]")].find((n) => n.dataset.key === "t-a"); const row = li && li.querySelector(".pl-row"); return row && row.dataset.on === "1" ? 1 : 0; })()`);
        await page(`(() => { const c = document.querySelector('#view .rt-pane-a .chip[data-kind="sight"]'); if (c && c.getAttribute("aria-pressed") === "true") c.click(); return 1; })()`);
        check(`${vw}: a pin tapped on the map beside the list marks its row, and the mark stays when the list is drawn again`, !!pin && marked === 1 && redrew === 1 && kept === 1, JSON.stringify({ pin: !!pin, marked, redrew, kept }));
      } else {
        await open(taveuni, "open");
        const listed = await fromList("t-b");
        r = JSON.parse(await page(READ));
        await still("taveuni-from-list");
        check(`${vw}: a place opened from the list (east of 180°) is shown the short way, in view`, listed === 1 && Math.abs(r.cam.lng) > 179 && r.inside >= 1 && !r.under.length, JSON.stringify({ listed, cam: { lng: +r.cam.lng.toFixed(3), zoom: +r.cam.zoom.toFixed(2) }, marks: r.marks, inside: r.inside, under: r.under }));
      }
    }
    if (sz.strip) {
      section(`3. the strip the map shows, and a place's card (${at})`);
      // The strip: between the page's head (the first row, at the surface's middle, whose top element is the map's own)
      // and the panel's top. Each mark wholly in it or not; the picked place's pin; the panel's height less its dock;
      // the map's buttons and scale; the screen's + and the card's "Place page".
      const STRIP = `JSON.stringify((() => {
        const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { l: r.left, r: r.right, t: r.top, b: r.bottom } : null; };
        const root = document.querySelector("#view .mp-root");
        const surf = box(document.querySelector("#view .mp-surface") || root);
        const sheet = document.querySelector("#view .mp-sheet");
        const sb = root.dataset.sheet === "open" ? box(sheet) : null;
        const bottom = sb ? Math.min(surf.b, sb.t) : surf.b;
        const midX = (surf.l + surf.r) / 2;
        let top = surf.t;
        for (let y = Math.max(0, Math.ceil(surf.t)); y < bottom; y++) {
          const el = document.elementFromPoint(midX, y + 0.5);
          if (el && el.closest(".mp-root") && !el.closest(".mp-sheet")) { top = y; break; }
        }
        const marks = [...document.querySelectorAll("#view .mp-pin, #view .mp-cluster")].filter((n) => getComputedStyle(n).display !== "none")
          .map((n) => ({ id: n.dataset.id || "", on: n.dataset.on === "1", group: n.classList.contains("mp-cluster"), ...box(n.firstElementChild) })).filter((m) => m.r != null);
        const whole = (m) => m.t >= top - 0.5 && m.b <= bottom + 0.5 && m.l >= surf.l - 0.5 && m.r <= surf.r + 0.5;
        const dock = parseFloat(getComputedStyle(root).getPropertyValue("--mp-dock")) || 0;
        const picked = marks.find((m) => m.on) || null;
        const furniture = [...document.querySelectorAll("#view .mp-ctrl, #view .mp-scale")].map((n) => ({ what: n.getAttribute("aria-label") || "scale", ...box(n) })).filter((c) => c.r != null);
        const fab = box(document.querySelector("#rt-fixed .fab"));
        const page = box(document.querySelector('#view .mp-acts [data-act="details"]'));
        const hit = (a, c) => !!a && !!c && !(a.r <= c.l || a.l >= c.r || a.b <= c.t || a.t >= c.b);
        const acts = [...document.querySelectorAll("#view .mp-acts .btn")].map(box).filter(Boolean);
        const sheetBox = box(sheet);
        const actsIn = !!sheetBox && acts.length === 2 && acts.every((a) => a.t >= sheetBox.t - 0.5 && a.b <= sheetBox.b + 0.5 && a.r <= sheetBox.r + 0.5);
        // A bar over the map's foot (the pill on a phone held upright): the card's buttons wholly above it. The card's ✕
        // with the room it takes to a thumb (44 tall, downward, 6 px a side: map.js .mp-x::before), and the + not on it.
        const tabbar = box(document.querySelector(".tabbar"));
        const barOver = tabbar && getComputedStyle(document.querySelector(".tabbar")).position === "fixed" ? tabbar : null;
        const actsUnderBar = acts.filter((a) => hit(a, barOver)).length;
        const xb = box(document.querySelector("#view .mp-x"));
        const xTap = xb ? { l: xb.l - 6, r: xb.r + 6, t: xb.t, b: Math.max(xb.b, xb.t + 44) } : null;
        const rail = document.body.dataset.bar === "first";
        const addr = document.querySelector("#view .mp-addr");
        const addrLines = addr && addr.textContent.trim() ? Math.round(addr.getBoundingClientRect().height / parseFloat(getComputedStyle(addr).lineHeight)) : 0;
        return { mode: root.dataset.mode || "", strip: { t: top, b: Math.round(bottom) }, marks: marks.length, whole: marks.filter(whole).length,
          cut: marks.filter((m) => !whole(m)).map((m) => (m.group ? "group " : "pin ") + Math.round(m.t) + "-" + Math.round(m.b)),
          picked: picked ? { t: Math.round(picked.t), b: Math.round(picked.b), whole: whole(picked) } : null,
          panel: sb ? Math.round(sb.b - sb.t - dock) : 0,
          underHead: furniture.filter((c) => c.t < top - 0.5).map((c) => c.what + " top " + Math.round(c.t)),
          addOnPage: hit(fab, page), fab: !!fab, pageBtn: !!page, actsIn, addrLines,
          bar: barOver ? { t: Math.round(barOver.t), l: Math.round(barOver.l), r: Math.round(barOver.r) } : null, rail,
          actsB: acts.length ? Math.round(Math.max(...acts.map((a) => a.b))) : null, actsUnderBar, x: !!xb, addOnX: hit(fab, xTap) };
      })())`;
      const short = vh <= 420;
      // The panel's height: 150 on a short screen (the map keeps more than a sliver), else as before (190 to 300).
      await open(corner, "open");
      let s = JSON.parse(await page(STRIP));
      check(`${at}: the panel opens at ${short ? "150 px (a short screen)" : "190 to 300 px, as before (not a short screen)"}`,
        short ? s.panel === 150 : s.panel >= 190 && s.panel <= 300, JSON.stringify({ panel: s.panel, strip: s.strip }));
      if (short) {
        for (const [what, tag, trip] of [["the grid", "grid", corner], ["the row of stops", "rows", rows]]) {
          await open(trip, "open");
          s = JSON.parse(await page(STRIP));
          check(`${at}, ${what}, panel open: on first open every mark wholly in the strip between the head and the panel`, s.marks >= 1 && s.whole === s.marks, JSON.stringify({ strip: s.strip, marks: s.marks, cut: s.cut }));
          await tapCtrl("Show all places");
          s = JSON.parse(await page(STRIP));
          await still(`${tag}-strip-show-all`);
          check(`${at}, ${what}, panel open: after "Show all places" every mark wholly in the strip`, s.marks >= 1 && s.whole === s.marks, JSON.stringify({ strip: s.strip, marks: s.marks, cut: s.cut }));
        }
      }
      // A place's card from the panel's list: its pin wholly in the strip above the card; on a narrow screen the + not
      // on the card's "Place page"; the map's buttons and scale not up under the head.
      await open(corner, "open");
      const listed = await fromList("g-0");
      s = JSON.parse(await page(STRIP));
      await still("card-from-list");
      check(`${at}: a place's card opened from the list: its pin wholly in the strip above the card`, listed === 1 && s.mode === "card" && !!s.picked && s.picked.whole, JSON.stringify({ listed, mode: s.mode, strip: s.strip, picked: s.picked }));
      check(`${at}: and the map's buttons and scale stand below the page's head`, !s.underHead.length, JSON.stringify({ strip: s.strip, underHead: s.underHead }));
      check(`${at}: and the card's two buttons wholly in it (nothing clipped)${short ? ", its address on one line" : ""}`, s.actsIn && (!short || s.addrLines <= 1), JSON.stringify({ actsIn: s.actsIn, addrLines: s.addrLines }));
      check(`${at}: and the + ${s.fab ? "is not on" : "(none at this width) is not on"} the card's "Place page"`, s.pageBtn && !s.addOnPage, JSON.stringify({ fab: s.fab, pageBtn: s.pageBtn, addOnPage: s.addOnPage }));
      check(`${at}: and the card's two buttons wholly above any bar over the map's foot${s.bar ? "" : " (none here)"}`, s.actsB != null && !s.actsUnderBar, JSON.stringify({ bar: s.bar, actsB: s.actsB, actsUnderBar: s.actsUnderBar }));
      check(`${at}: and the + ${s.fab ? "is not on" : "(none at this width) is not on"} the card's ✕ (with its room to a thumb)`, s.x && !s.addOnX, JSON.stringify({ fab: s.fab, x: s.x, addOnX: s.addOnX }));
      // On a screen on its side no taller than 420 the bar is the rail beside the page (tabs.js RAIL), so nothing floats
      // over the card's foot: at 667 x 375 a pill did (19 Nov), 72 of the 375 px.
      if (short) check(`${at}: on its side, the bar is the rail beside the map, not over its foot`, s.rail && !s.bar, JSON.stringify({ rail: s.rail, bar: s.bar }));
      // Offline, the panel is taller by the offline pill's dock (map.js --mp-dock): a place's card opened then, its
      // buttons and scale still under the head.
      if (short) {
        await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
        await waitFor(cdp, S, `document.body.dataset.netpill === "1" ? 1 : 0`, { label: "the offline pill", timeout: 20000 });
        await page(`(() => { const x = document.querySelector('#view [data-act="clear"]'); if (x) x.click(); return 1; })()`);
        await sleep(900);
        const again = await fromList("g-1");
        s = JSON.parse(await page(STRIP));
        await still("card-offline");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
        check(`${at}: offline (the panel taller by the pill's dock), a place's card: the map's buttons and scale below the head, the + not on "Place page" or the ✕, the card's buttons above any bar`,
          again === 1 && s.mode === "card" && !s.underHead.length && !s.addOnPage && !s.addOnX && !s.actsUnderBar,
          JSON.stringify({ again, mode: s.mode, strip: s.strip, underHead: s.underHead, addOnPage: s.addOnPage, addOnX: s.addOnX, bar: s.bar, actsB: s.actsB }));
      }
      // A pin tapped on the map, low on the screen with the panel shut: its card opens, and the map moves only as far as
      // keeps the pin wholly in view above it.
      await open(corner, "shut");
      const p0 = CORNERS[0];
      await page(`(__wgpMapView.jumpTo({ lng: ${p0.lng}, lat: ${p0.lat}, zoom: 15, offset: [0, ${Math.round(vh / 2 - 90)}] }), 1)`);
      await sleep(900);
      const pin = JSON.parse(await page(`JSON.stringify((() => { const p = document.querySelector('#view .mp-pin[data-id="${p0.id}"]'); if (!p) return null; const q = p.firstElementChild.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })())`));
      if (pin) for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: pin.x, y: pin.y, button: "left", clickCount: 1 }, S);
      await sleep(1500);
      s = JSON.parse(await page(STRIP));
      await still("card-from-pin");
      check(`${at}: a pin tapped low on the map: its card opens and the pin stays wholly in view above it`, !!pin && s.mode === "card" && !!s.picked && s.picked.whole, JSON.stringify({ pin, mode: s.mode, strip: s.strip, picked: s.picked }));
    }
    check(`${at}: no page error`, b.pageErrors.length === 0, b.pageErrors.join(" | ").slice(0, 300));
  }
} catch (e) {
  fail++;
  failures.push(`STOPPED: ${e.message}`);
  console.log(`\nSTOPPED: ${e.stack || e}`);
} finally {
  for (const b of browsers) await b.done().catch(() => {});
  await server.stop().catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log(`failed:\n  ${failures.join("\n  ")}`);
process.exit(fail ? 1 : 0);
