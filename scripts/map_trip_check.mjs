#!/usr/bin/env node
/* The map and Places read the trip: its areas, its places, its own offline map. In a real
 * browser, on a server of its own, with the map's GL engine and then its flat one.
 *
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
 *     --label "wegoplace map_trip_check.mjs" -- node scripts/map_trip_check.mjs
 *
 * WGP_SHOTS=<folder> also writes pictures to look at. Nothing is asserted from them.
 *
 * The server is this check's own (checks/lib/server.mjs: an empty database, a port of its
 * own). One made-up person makes a trip; what "another device" does is that person's API.
 * No route gives a trip an offline map yet, so the check plays that part of the server
 * itself, in the browser's network layer: it adds `tiles` to the trip's snapshot and answers
 * GET|HEAD /api/trips/<id>/tiles?v=<version> (Range) with a small valid archive of no tiles.
 *
 * WHAT IT PROVES
 *   1. A TRIP WITH NOTHING IN IT has a map: the whole planet, no plates, no region names, and
 *      not one request for an archive.
 *   2. AREAS AND PLACES ARRIVE from another device: the words on a row, on the map's list and
 *      on a place's page are the trip's own ("Old Town, Harbor City"); a place with no area
 *      has no empty bit; the map names the trip's regions.
 *   3. EITHER SIDE OF THE 180° LINE (each engine): two places 0.7° apart across the line are
 *      0.7° apart on screen; a region across the line is one plate; the two cluster together
 *      under their region's name; "Show all places" fits them, not the planet.
 *   3b. A REGION'S NAME IS WORN BY ONE DISC OR BY NONE (flat): two discs of one region on
 *      screen wear no name; drawn together into one disc, it wears the region's name.
 *   4. A STORED CAMERA a continent away from the trip is not restored; one near it is.
 *   5. THE TRIP'S OWN OFFLINE MAP (GL): asked for at the trip's address only when the trip has
 *      one; kept on the phone once; not fetched again while the server's copy is the same;
 *      fetched again when it changed; drawn from the phone's copy with the API out of reach;
 *      gone when the trip no longer has one; an archive that will not open is tried once, not
 *      on every change; a phone from before keeps its old archive as this trip's.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { emptyArchive } from "./lib/empty_archive.mjs";

const server = await startServer({ name: "map-trip", port: await freeLoopbackPort() });
ownServer(server.origin);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const SHOTS = process.env.WGP_SHOTS || "";
// Planted: MAPTRIP_PLANT=slowdraw slows the page 40 times (CDP CPU throttling) while the map that was being made arrives
// in 6, as a loaded machine does: its streets draw a while after the tiles are switched on, and the check must wait for
// the draw (drawn()), not go red reading the "arriving" line that rightly stays until then. (The archive's reads can't
// hold the draw back: the map reads its header before it switches the tiles on.)
const PLANT = process.env.MAPTRIP_PLANT || "";
if (PLANT && PLANT !== "slowdraw") throw new Error(`no such plant: ${PLANT}`);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const AREAS = [
  { id: "harbor", name: "Harbor City", west: -9.3, south: 38.6, east: -9.0, north: 38.9, sort: 0 },
  { id: "old-town", name: "Old Town", parent: "harbor", sort: 1 },
  { id: "islands", name: "The Islands", west: 177, south: -19, east: -178, north: -16, sort: 2 },
  { id: "coast", name: "The Coast", sort: 3 },
];
const PLACES = [
  { id: "cafe-one", name: "Cafe One", kind: "food", subkind: "cafe", why: "Breakfast on the first day.", area: "old-town", lat: 38.71, lng: -9.14, rating: 4.6, rating_count: 120 },
  { id: "bakery-two", name: "Bakery Two", kind: "food", subkind: "bakery", why: "Bread for the road.", area: "harbor", lat: 38.72, lng: -9.13 },
  { id: "west-beach", name: "West Beach", kind: "sight", subkind: "beach", why: "A swim before the boat.", area: "islands", lat: -17.5, lng: 179.6 },
  { id: "east-beach", name: "East Beach", kind: "sight", subkind: "beach", why: "A swim after the boat.", area: "islands", lat: -17.4, lng: -179.7 },
  { id: "lone-office", name: "Lone Office", kind: "practical", subkind: "tourist_office", why: "Maps and a stamp.", lat: 48.85, lng: 2.35 },
];

let b = null;
try {
  await server.start();
  const host = new Person(server.origin, "Mara Voss");
  await host.signUp();
  const made = await host.post("/api/trips", { name: "Island hop", default_tz: "Pacific/Fiji" });
  const trip = made.json && made.json.trip && made.json.trip.id;
  if (!trip) throw new Error(`making the trip: ${made.status} ${made.text.slice(0, 200)}`);
  const AT = `/api/trips/${trip}`;
  const ARCHIVE = `${AT}/tiles`;
  // Somebody on the trip who doesn't host it: the last section looks at the map as them.
  const other = new Person(server.origin, "Teo Lind");
  await other.signUp();
  const link = await host.post(`${AT}/links`, {});
  const joined = await other.post(`/api/join/${link.json && link.json.link && link.json.link.code}`);
  if (joined.status >= 300) throw new Error(`joining the trip: ${joined.status} ${joined.text.slice(0, 200)}`);

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");

  // What the check plays of the server: what the trip says about its offline map (docs/API.md,
  // "The trip's map") and the archive behind it.
  //   state, ready, version, note, source   as the snapshot's `tiles` has them
  //   bytes     the archive; says   the size the snapshot CLAIMS (an uploaded map over the budget)
  //   cut       what "make it again" (POST …/tiles/cut) meets: "server" (this check's own server, which
  //             makes no maps and says so), "offline" (the request dies on the wire), or "ok" (asked:
  //             the map is being made from then on)
  const play = { state: "none", ready: false, version: "one", note: "", source: "cut", bytes: emptyArchive(4000), says: 0, broken: false, cut: "server" };
  const tilesNow = () => (play.state === "none" && !play.ready ? null
    : { state: play.state, version: play.version, bytes: play.says || play.bytes.length, at: 1790000000, source: play.source, note: play.note, glyphs: null, ready: play.ready });
  const asked = { head: 0, range: 0, whole: 0, old: [], versions: [], cut: [] };
  const allErrors = [];

  // One browser, one engine. Everything below is written against these helpers.
  async function open(gl, who = host) {
    b = await boot({ vw: 390, vh: 844, dsf: 1, gl });
    const { cdp, S } = b;
    const page = (expr) => evalIn(cdp, S, expr);
    const inStore = (body) => page(`import("/js/store.js").then(({ store }) => { ${body} })`);
    for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
    await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: who.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
    const name = who.jar.cookies.get("wgp_who");
    if (name) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: name, sameSite: "Lax" }, S);

    // The archive's address, answered here; and the snapshot, given its `tiles`.
    await cdp.send("Fetch.enable", { patterns: [
      { urlPattern: `*${ARCHIVE}*`, requestStage: "Request" },
      { urlPattern: `*${AT}`, requestStage: "Response" },
      { urlPattern: `*${AT}?*`, requestStage: "Response" },
    ] }, S);
    cdp.on(async (m) => {
      if (m.sessionId !== S) return;
      if (m.method === "Network.requestWillBeSent") {
        const u = new URL(m.params.request.url);
        if (/^\/tiles\/.*\.pmtiles$/.test(u.pathname)) asked.old.push(u.pathname);
        return;
      }
      if (m.method !== "Fetch.requestPaused") return;
      const { requestId, request } = m.params;
      const u = new URL(request.url);
      try {
        // "Make it again", as play.cut has it.
        if (u.pathname === `${ARCHIVE}/cut`) {
          // The trip's own pattern above also stops this address on its way back (a "?" in a
          // pattern stands for any one character): that second stop is let through, uncounted.
          if (m.params.responseStatusCode !== undefined || m.params.responseErrorReason) { await cdp.send("Fetch.continueRequest", { requestId }, S); return; }
          asked.cut.push(request.method);
          if (play.cut === "offline") { await cdp.send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" }, S); return; }
          if (play.cut === "ok") {
            play.state = "cutting"; play.note = "";
            await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
              responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Cache-Control", value: "no-store" }],
              body: Buffer.from('{"ok":true,"asked":true}').toString("base64") }, S);
            return;
          }
          await cdp.send("Fetch.continueRequest", { requestId }, S);
          return;
        }
        if (u.pathname === ARCHIVE) {
          const text = (code, body) => cdp.send("Fetch.fulfillRequest", { requestId, responseCode: code,
            responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Cache-Control", value: "no-store" }],
            body: Buffer.from(body).toString("base64") }, S);
          asked.versions.push(u.searchParams.get("v"));
          if (!play.ready || play.broken) { await text(404, '{"error":"no map"}'); if (request.method === "HEAD") asked.head++; else asked.range++; return; }
          const size = play.bytes.length;
          const common = [{ name: "Content-Type", value: "application/octet-stream" }, { name: "Accept-Ranges", value: "bytes" },
            { name: "ETag", value: `"${play.version}"` }, { name: "Cache-Control", value: "private, no-cache" }];
          if (request.method === "HEAD") {
            asked.head++;
            await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [...common, { name: "Content-Length", value: String(size) }] }, S);
            return;
          }
          const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === "range");
          const mm = range && /^bytes=(\d+)-(\d+)$/.exec(range[1]);
          if (!mm) {
            asked.whole++;
            await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [...common, { name: "Content-Length", value: String(size) }],
              body: play.bytes.toString("base64") }, S);
            return;
          }
          asked.range++;
          const from = Number(mm[1]), to = Math.min(Number(mm[2]), size - 1);
          await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 206,
            responseHeaders: [...common, { name: "Content-Range", value: `bytes ${from}-${to}/${size}` }, { name: "Content-Length", value: String(to - from + 1) }],
            body: play.bytes.subarray(from, to + 1).toString("base64") }, S);
          return;
        }
        // The snapshot: only a 200 with a body has anything to add `tiles` to.
        if (m.params.responseStatusCode === 200 && request.method === "GET") {
          const got = await cdp.send("Fetch.getResponseBody", { requestId }, S);
          const snap = JSON.parse(got.base64Encoded ? Buffer.from(got.body, "base64").toString("utf8") : got.body);
          if (snap && snap.trip) snap.tiles = tilesNow();
          const headers = (m.params.responseHeaders || []).filter((h) => !/^content-(length|encoding)$/i.test(h.name));
          await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: headers,
            body: Buffer.from(JSON.stringify(snap)).toString("base64") }, S);
          return;
        }
        await cdp.send("Fetch.continueRequest", { requestId }, S);
      } catch (e) {
        console.log(`  (the check's own answer failed: ${u.pathname} ${e.message})`);
        try { await cdp.send("Fetch.continueRequest", { requestId }, S); } catch { /* already answered */ }
      }
    });

    const go = async (address) => { await cdp.send("Page.navigate", { url: `${server.origin}${address}` }, S); await sleep(300); };
    const view = (body) => page(`(() => { const v = window.__wgpMapView; if (!v) return null; ${body} })()`);
    // Open the trip's map and wait for the engine this browser gives it.
    const openMap = async (extra = "", label = "the map") => {
      await go(`/t/${trip}/?${Date.now()}#/places?view=map${extra}`);
      await appSettled(cdp, S);
      await waitFor(cdp, S, `document.querySelector(".mp-root") && window.__wgpMapView ? 1 : 0`, { label });
      await waitFor(cdp, S, `window.__wgpMapView.engine() === ${JSON.stringify(gl ? "gl" : "flat")} ? 1 : 0`, { label: `${label}: the ${gl ? "GL" : "flat"} engine`, timeout: 60000 });
      await sleep(900);
    };
    const cam = async () => JSON.parse(await view(`return JSON.stringify(v.cam());`));
    const jump = async (c) => { await view(`v.jumpTo(${JSON.stringify(c)}); return 1;`); await sleep(700); };
    const at = async (lng, lat) => JSON.parse(await view(`return JSON.stringify(v.project(${lng}, ${lat}));`));
    const pin = async (id) => JSON.parse(await page(`(() => { const n = document.querySelector('.mp-pin[data-id="${id}"]'); if (!n) return "null";
      const r = n.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.bottom, w: r.width }); })()`));
    // The commonest colour in a 9 px square of the drawn ground, at a point of the map.
    const ground = async (lng, lat) => page(`(() => {
      const v = window.__wgpMapView, c = document.querySelector(".mp-ink");
      const p = v.project(${lng}, ${lat});
      const k = c.width / c.getBoundingClientRect().width;
      const d = c.getContext("2d").getImageData(Math.round(p.x * k) - 4, Math.round(p.y * k) - 4, 9, 9).data;
      const n = new Map();
      for (let i = 0; i < d.length; i += 4) { const key = d[i] + "," + d[i + 1] + "," + d[i + 2] + "," + d[i + 3]; n.set(key, (n.get(key) || 0) + 1); }
      return [...n].sort((a, b) => b[1] - a[1])[0][0];
    })()`);
    const tap = async (sel, label = sel) => {
      const got = await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return 0; n.click(); return 1; })()`);
      if (got !== 1) throw new Error(`tap: ${label} is not there`);
      await sleep(500);
    };
    const refresh = async () => { await inStore(`return store.refresh();`); await sleep(500); };
    const look = async (name) => { if (SHOTS) await b.shot(path.join(SHOTS, `${gl ? "gl" : "flat"}-${name}.png`)); };
    const cacheKeys = async () => JSON.parse(await page(`(async () => {
      const c = await caches.open("wgp-tiles-v1"); const out = {};
      for (const rq of await c.keys()) { const r = await c.match(rq); out[new URL(rq.url).pathname + new URL(rq.url).search] = (await r.blob()).size; }
      return JSON.stringify(out); })()`));
    // The version the phone's copy says it is.
    const keptVersion = () => page(`caches.open("wgp-tiles-v1").then((c) => c.match(${JSON.stringify(ARCHIVE)})).then((r) => (r ? r.headers.get("X-Map-Version") : null))`);
    // The card the map shows about itself: its words and its buttons, or null.
    const note = async () => JSON.parse(await page(`(() => { const n = document.querySelector(".mp-note"); if (!n || n.hidden) return "null";
      const r = n.getBoundingClientRect();
      return JSON.stringify({ kind: n.dataset.kind, words: n.querySelector(".mp-note-t").textContent, more: (n.querySelector(".mp-note-more") || { textContent: "" }).textContent, acts: [...n.querySelectorAll("[data-note]")].map((b) => b.textContent), on: r.width > 100 && r.height > 20 && r.top >= 0 && r.bottom < innerHeight }); })()`));
    // Every box of the map that matters, each pin's tip and name, and the panel's words.
    const layout = async () => JSON.parse(await page(`JSON.stringify((() => {
      const r = (s) => { const n = document.querySelector(s); if (!n) return null; const q = n.getBoundingClientRect(); return { l: q.left, t: q.top, r: q.right, b: q.bottom }; };
      const ink = document.querySelector(".mp-ink");
      // One row of the drawn ground, half way up the space above the panel: how many colours.
      const sheet = r(".mp-sheet"), head = r(".pl-head"), ib = ink.getBoundingClientRect(), k = ink.width / ib.width;
      const row = ink.getContext("2d").getImageData(0, Math.round(((head.b + sheet.t) / 2 - ib.top) * k), ink.width, 1).data;
      const tones = new Set(); for (let i = 0; i < row.length; i += 4) tones.add(row[i] + "," + row[i + 1] + "," + row[i + 2]);
      return { view: r("#view"), head, root: r(".mp-root"), sheet, ctrls: r(".mp-ctrls"), scale: r(".mp-scale"), ink: r(".mp-ink"),
        inkPx: [ink.width, ink.height, Math.min(3, window.devicePixelRatio || 1)], tones: tones.size,
        words: document.querySelector(".mp-body").innerText.replace(/\\s+/g, " ").trim(),
        pins: [...document.querySelectorAll(".mp-pin")].map((n) => { const q = n.getBoundingClientRect(), lq = n.querySelector(".mp-pin-label").getBoundingClientRect();
          return { id: n.dataset.id, x: q.left, y: q.top, name: n.dataset.label === "1" ? { l: lq.left, r: lq.right, t: lq.top, b: lq.bottom } : null }; }),
        clusters: document.querySelectorAll(".mp-cluster").length,
        reduce: matchMedia("(prefers-reduced-motion: reduce)").matches };
    })())`));
    const motion = async (reduce) => { await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }] }, S); await sleep(200); };
    return { cdp, S, page, inStore, go, view, openMap, cam, jump, at, pin, ground, tap, refresh, look, cacheKeys, keptVersion, note, sleep, waitFor, layout, motion };
  }

  // ── 3 (each engine). either side of the 180° line ────────────────────────────────────────
  async function theLine(t, engine) {
    section(`3 (${engine}). either side of the 180° line`);
    await t.openMap("", "the map, with the trip's places");
    await t.jump({ lng: 180, lat: -17.5, zoom: 7 });
    const w = await t.pin("west-beach"), e = await t.pin("east-beach");
    // 0.7° of longitude at zoom 7 is 0.7 × 512 × 2^7 / 360 = 127 px.
    check(`${engine}: two places 0.7° apart across the line are 127 px apart, west of east`,
      !!w && !!e && w.x > 0 && e.x < 390 && e.x - w.x > 120 && e.x - w.x < 134, JSON.stringify({ w, e }));
    const pw = await t.at(179.6, -17.5), pe = await t.at(-179.7, -17.4);
    check(`${engine}: the projection agrees`, pe.x - pw.x > 120 && pe.x - pw.x < 134, JSON.stringify({ pw, pe }));
    await t.look("the-line-zoom-7");

    await t.jump({ lng: 180, lat: -17.5, zoom: 5 });
    const inA = await t.ground(178.5, -17.5), inB = await t.ground(-179, -17.5);
    // 3.8° west of the line at zoom 5 is 173 px left of the middle of a 390 px screen: on it.
    const outA = await t.ground(176.2, -17.5), outB = await t.ground(-176.6, -17.5);
    check(`${engine}: a region across the line is one plate: both sides of the line are inside it`, inA === inB && inA !== outA, JSON.stringify({ inA, inB, outA, outB }));
    check(`${engine}: and the ground either side of the plate is not`, outA === outB && outA !== inA, JSON.stringify({ inA, outA, outB }));
    await t.look("the-line-plate");

    await t.jump({ lng: 180, lat: -17.5, zoom: 4 });
    const isl = JSON.parse(await t.page(`JSON.stringify([...document.querySelectorAll(".mp-cluster")].map((n) => ({ ids: n.dataset.ids, name: n.querySelector(".mp-cluster-name").textContent.trim() })))`));
    const both = isl.find((c) => (c.ids || "").split(",").sort().join() === "east-beach,west-beach");
    check(`${engine}: the two cluster together across the line, under their region's name`, !!both && both.name === "The Islands", JSON.stringify(isl));
    await t.jump({ lng: -9.1, lat: 38.7, zoom: 5 });
    const hc = JSON.parse(await t.page(`JSON.stringify([...document.querySelectorAll(".mp-cluster")].map((n) => ({ ids: n.dataset.ids, name: n.querySelector(".mp-cluster-name").textContent.trim() })))`));
    const town = hc.find((c) => (c.ids || "").split(",").sort().join() === "bakery-two,cafe-one");
    check(`${engine}: a place in a neighborhood is named by its region`, !!town && town.name === "Harbor City", JSON.stringify(hc));
    const hin = await t.ground(-9.15, 38.75), hout = await t.ground(-7.5, 38.75);
    check(`${engine}: an ordinary region is a plate too`, hin !== hout && hin === inA, JSON.stringify({ hin, hout, inA }));

    // "Show all places", with only the sights showing: the two beaches.
    await t.tap('.pl-chips [data-kind="sight"], [data-kind="sight"]', "the Sights chip");
    await t.tap('.mp-ctrl[data-act="fit"]', "Show all places");
    await t.sleep(900);
    const c = await t.cam();
    const off = Math.abs((((c.lng - 180) % 360) + 540) % 360 - 180);
    check(`${engine}: "Show all places" fits the two across the line, not the planet`, off < 0.6 && c.zoom > 7 && Math.abs(c.lat + 17.45) < 0.5, JSON.stringify(c));
    const w2 = await t.pin("west-beach"), e2 = await t.pin("east-beach");
    check(`${engine}: and both are on screen`, !!w2 && !!e2 && w2.x > 0 && w2.x < 390 && e2.x > 0 && e2.x < 390 && w2.x < e2.x, JSON.stringify({ w2, e2 }));
    await t.look("the-line-fitted");
    await t.tap('.pl-chips [data-kind="sight"], [data-kind="sight"]', "the Sights chip, off again");
  }

  // The map's box. Its root reaches out of its host onto the whole of #view (under the head,
  // down to the tab bar); the drawn ground is as tall as that; nothing of its chrome is under
  // the panel. Every harness here runs with motion reduced. While the app gave every style
  // change a 0.01 ms transition there, a map that measured itself straight after moving itself
  // moved again on every pass, and an empty trip's map sat 284 px up the screen. The rule is
  // no transition at all now (styles.css), and the map's own boxes take none under any setting.
  const near1 = (a, b2) => Math.abs(a - b2) <= 1;
  const sits = (L, what) => {
    check(`${what}: the map fills the view, from under the head to the tab bar`,
      near1(L.root.t, L.view.t) && near1(L.root.b, L.view.b) && near1(L.root.l, L.view.l) && near1(L.root.r, L.view.r), JSON.stringify({ root: L.root, view: L.view }));
    check(`${what}: the drawn ground is as tall as the map`,
      near1(L.ink.t, L.root.t) && near1(L.ink.b, L.root.b) && Math.abs(L.inkPx[1] - (L.root.b - L.root.t) * L.inkPx[2]) <= 2, JSON.stringify({ ink: L.ink, px: L.inkPx, root: L.root }));
    check(`${what}: the buttons and the scale are between the head and the panel, and the panel ends at the map's foot`,
      L.ctrls.t >= L.head.b && L.ctrls.b <= L.sheet.t && L.scale.b <= L.sheet.t && near1(L.sheet.b, L.root.b) && L.sheet.t > L.head.b + 150, JSON.stringify({ head: L.head, ctrls: L.ctrls, scale: L.scale, sheet: L.sheet }));
  };
  // A fit puts every pin, whole and with its name, in the space the head, the panel, the scale
  // riding above it and the buttons leave, and in the middle of it (the numbers are map.js's
  // own insets: since 15 Nov a point also stands 4 px above the scale's top).
  const fits = (L, what) => {
    const xs = L.pins.map((q) => q.x), ys = L.pins.map((q) => q.y);
    const box = { l: 41, r: L.root.r - 85, t: L.head.b + 52, b: Math.min(L.sheet.t - 34, L.scale.t - 4) };
    check(`${what}: every pin is in the space the head, the panel and the buttons leave`,
      L.pins.length === 3 && L.clusters === 0 && Math.min(...xs) >= box.l - 1 && Math.max(...xs) <= box.r + 1 && Math.min(...ys) >= box.t - 1 && Math.max(...ys) <= box.b + 1,
      JSON.stringify({ box, pins: L.pins.map((q) => [q.id, Math.round(q.x), Math.round(q.y)]) }));
    check(`${what}: and in the middle of it`,
      Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - (box.l + box.r) / 2) <= 2 && Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - (box.t + box.b) / 2) <= 2,
      JSON.stringify({ box, x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)] }));
    const west = L.pins.slice().sort((a, b2) => a.x - b2.x)[0];
    check(`${what}: the pin nearest the edge has its name, whole, under it, clear of the panel`,
      !!west.name && west.name.l >= 2 && west.name.r <= L.root.r - 2 && west.name.l <= west.x && west.name.r >= west.x && west.name.b <= L.sheet.t, JSON.stringify(west));
  };

  // ═══ the GL engine ═══════════════════════════════════════════════════════════════════════
  let t = await open(true);

  section("1. a trip with nothing in it has a map");
  await t.openMap("", "an empty trip's map");
  let c = await t.cam();
  check("it opens on the whole planet, not on a place this trip never named", Math.abs(c.lng) < 1 && Math.abs(c.lat - 20) < 1 && Math.abs(c.zoom - 3) < 0.01, JSON.stringify(c));
  check("it has no regions", (await t.view(`return v.regions().length;`)) === 0);
  check("no pins, no clusters", (await t.page(`document.querySelectorAll(".mp-pin,.mp-cluster").length`)) === 0);
  await t.sleep(6000);    // long enough for an archive to have been asked for, if one were going to be
  check("it draws its own ground: no tiles", (await t.view(`return v.tiles();`)) === false);
  check("not one request for an archive, at either address", asked.head + asked.range + asked.whole === 0 && asked.old.length === 0, JSON.stringify(asked));
  let L = await t.layout();
  check("the check's browser asks for reduced motion (what every box below is measured under)", L.reduce === true);
  sits(L, "an empty trip");
  check("its panel says the trip has no places", L.words === "No places on this trip yet.", L.words);
  check("its ground has the planet's lines on it", L.tones >= 2, `${L.tones} colours across one row`);
  await t.look("empty-trip-map");

  section("1b. the map's box and its first fit");
  const EARLY = [
    { id: "night-bar", name: "Night Bar", kind: "drink", subkind: "bar", why: "Late." },
    { id: "old-fort", name: "The Old Fort", kind: "sight", subkind: "castle", why: "The view.", area: "harbor", lat: 38.75, lng: -9.2 },
  ];
  const early = (await host.call("PUT", `${AT}/areas`, { areas: AREAS })).status + " " + (await host.call("PUT", `${AT}/places`, { places: EARLY.slice(0, 1) })).status;
  await t.refresh();
  await t.waitFor(t.cdp, t.S, `import("/js/store.js").then(({ store }) => store.areas().length === 4 && store.places().length === 1 ? 1 : 0)`, { label: "the areas and one place with no pin" });
  await t.sleep(900);
  L = await t.layout();
  check("a trip whose one place has no pin: the panel says where it is", early === "200 200" && L.words === "This trip's one place isn't on the map yet. It is in the list.", `${early} ${L.words}`);
  sits(L, "areas, and a place with no pin");
  await t.look("one-place-no-pin");
  const trio = await host.call("PUT", `${AT}/places`, { places: [EARLY[1], PLACES[0], PLACES[1]] });
  await t.refresh();
  await t.waitFor(t.cdp, t.S, `import("/js/store.js").then(({ store }) => store.places().length === 4 ? 1 : 0)`, { label: "three places with pins" });
  await t.sleep(1200);
  L = await t.layout();
  check("three pinned places arrive while the map is open", trio.status === 200 && L.pins.length === 3, `${trio.status} ${L.pins.length} pins`);
  sits(L, "places arrived");
  fits(L, "places arrived");
  await t.look("first-fit");
  // The + (Add a place) floats over the map's bottom right corner, where the map's own buttons
  // stand. With the panel shut they stand ABOVE the +, never under it: at 390 and at 320 wide.
  const corner = async () => JSON.parse(await t.page(`JSON.stringify((() => {
    const box = (n) => { const q = n.getBoundingClientRect(); return { l: q.left, t: q.top, r: q.right, b: q.bottom }; };
    const add = document.querySelector(".fab[data-place-add]"), peek = document.querySelector(".mp-peek"), root = document.querySelector(".mp-root");
    const mid = peek.getBoundingClientRect(), hit = document.elementFromPoint(mid.left + mid.width / 2, mid.top + mid.height / 2);
    return { sheet: root.dataset.sheet, add: add && !add.hidden ? box(add) : null, peek: box(peek), words: peek.innerText.trim(),
      ctrls: [...document.querySelectorAll(".mp-ctrl")].map(box), head: box(document.querySelector(".pl-head")), root: box(root),
      reached: !!hit && (hit === peek || peek.contains(hit)) }; })())`));
  const apart = (a, c) => a.r <= c.l || c.r <= a.l || a.b <= c.t || c.b <= a.t;
  for (const [w, h] of [[390, 844], [320, 640]]) {
    await b.metrics(w, h, 1);
    await t.sleep(700);
    await t.tap(".mp-grab", "the panel's handle, to shut it");
    await t.waitFor(t.cdp, t.S, `document.querySelector(".mp-root").dataset.sheet === "shut" ? 1 : 0`, { label: "the panel shut" });
    await t.sleep(600);
    const C = await corner();
    check(`${w} wide, the panel shut: "Nearby" and the map's three buttons are clear of the +, under the head, and "Nearby" is reached by a tap`,
      !!C.add && C.words === "Nearby" && C.reached && apart(C.add, C.peek) && C.ctrls.length === 3 && C.ctrls.every((q) => apart(C.add, q) && q.t >= C.head.b)
        && C.peek.b <= C.add.t && C.peek.r <= C.root.r, JSON.stringify(C));
    await t.look(`panel-shut-${w}`);
    await t.tap(".mp-peek", "Nearby, to open the panel again");
    await t.waitFor(t.cdp, t.S, `document.querySelector(".mp-root").dataset.sheet === "open" ? 1 : 0`, { label: "the panel open again" });
    await t.sleep(600);
  }
  await b.metrics(390, 844, 1);
  await t.sleep(900);
  L = await t.layout();
  sits(L, "the panel opened again");
  // A phone's screen has two or three pixels to the point. The drawn ground is a canvas, and a
  // canvas left to its own size is that many times too big: plates drawn far from their pins.
  await b.metrics(393, 852, 3);
  await t.sleep(1200);
  L = await t.layout();
  check("on a phone's screen (393 wide, three pixels to the point) the canvas has three times the pixels", L.inkPx[2] === 3 && L.inkPx[0] === 1179, JSON.stringify(L.inkPx));
  sits(L, "at a phone's pixel density");
  fits(L, "at a phone's pixel density");
  await b.metrics(390, 844, 1);
  await t.sleep(900);
  await t.tap('.pl-head .chip[data-kind="drink"]', "the Drink chip");
  await t.sleep(600);
  L = await t.layout();
  check("a filter whose places have no pins: the panel says so, and no pin is drawn", L.words === "Nothing in this filter is on the map." && L.pins.length === 0, `${L.words} / ${L.pins.length} pins`);
  await t.tap('.pl-head .chip[data-kind="drink"]', "the Drink chip, off");
  await t.motion(false);
  await t.openMap("", "the map, with motion");
  await t.sleep(900);
  L = await t.layout();
  check("the same trip opened with motion allowed", L.reduce === false && L.pins.length === 3, JSON.stringify({ reduce: L.reduce, pins: L.pins.length }));
  sits(L, "with motion");
  fits(L, "with motion");
  await t.motion(true);
  const gone = await host.call("DELETE", `${AT}/places`, { ids: EARLY.map((q) => q.id) });
  check("the two extra places are taken off again", gone.status === 200, `${gone.status} ${gone.text.slice(0, 200)}`);
  await t.openMap("", "the map again");

  section("2. areas and places arrive from another device");
  const putA = await host.call("PUT", `${AT}/areas`, { areas: AREAS });
  const putP = await host.call("PUT", `${AT}/places`, { places: PLACES });
  check("the server takes the areas and the places", putA.status === 200 && putP.status === 200, `${putA.status} ${putA.text.slice(0, 200)} / ${putP.status} ${putP.text.slice(0, 300)}`);
  await t.refresh();
  await t.waitFor(t.cdp, t.S, `import("/js/store.js").then(({ store }) => store.areas().length === 4 && store.places().length === 5 ? 1 : 0)`, { label: "the areas and places on the phone" });
  await t.sleep(900);
  const regs = JSON.parse(await t.view(`return JSON.stringify(v.regions());`));
  check("the map's regions are the trip's top-level areas, in its order", regs.map((r) => r.name).join("|") === "Harbor City|The Islands|The Coast" && !!regs[0].bounds && !!regs[1].bounds && regs[2].bounds === null, JSON.stringify(regs));
  c = await t.cam();
  check("the map left the whole planet for the trip's places", !(Math.abs(c.lng) < 1 && Math.abs(c.lat - 20) < 1), JSON.stringify(c));
  const near = JSON.parse(await t.page(`JSON.stringify([...document.querySelectorAll(".mp-body .pl-row")].map((n) => [n.dataset.pick, n.querySelector(".pl-meta").textContent.replace(/\\s+/g, " ").trim(), n.querySelector(".pl-rowrate")?.textContent.replace(/\\s+/g, " ").trim() || ""]))`));
  const nearOf = Object.fromEntries(near.map(([id, meta]) => [id, meta]));
  const nearRate = Object.fromEntries(near.map(([id, , rate]) => [id, rate]));
  check("the map's own list words each area as the trip does",
    /Old Town, Harbor City$/.test(nearOf["cafe-one"] || "") && /· ?Harbor City$/.test(nearOf["bakery-two"] || "") && /The Islands$/.test(nearOf["west-beach"] || ""), JSON.stringify(near));
  check("a place with no area has no empty bit on the map's list", !!nearOf["lone-office"] && !/·\s*$/.test(nearOf["lone-office"]) && !/^\s*·/.test(nearOf["lone-office"]), JSON.stringify(nearOf["lone-office"]));
  await t.look("places-arrived-map");

  await t.go(`/t/${trip}/?${Date.now()}#/places`);
  await appSettled(t.cdp, t.S);
  await t.waitFor(t.cdp, t.S, `document.querySelectorAll('a.pl-row').length === 5 ? 1 : 0`, { label: "the Places list" });
  const listEntries = JSON.parse(await t.page(`JSON.stringify([...document.querySelectorAll("li[data-key]")].map((li) => [li.dataset.key, li.querySelector(".pl-meta").textContent.replace(/\\s+/g, " ").trim(), li.querySelector(".pl-rowrate")?.textContent.replace(/\\s+/g, " ").trim() || ""]))`));
  const rows = Object.fromEntries(listEntries.map(([id, meta]) => [id, meta]));
  const listRate = Object.fromEntries(listEntries.map(([id, , rate]) => [id, rate]));
  check("the list words each area as the trip does",
    /Old Town, Harbor City$/.test(rows["cafe-one"] || "") && /Harbor City$/.test(rows["bakery-two"] || "") && !/Old Town/.test(rows["bakery-two"] || "") && /The Islands$/.test(rows["east-beach"] || ""), JSON.stringify(rows));
  check("a place with no area has no empty bit on its row", !!rows["lone-office"] !== undefined && !/·\s*$/.test(rows["lone-office"] || "x ·") && !/·\s*·/.test(rows["lone-office"] || "· ·"), JSON.stringify(rows["lone-office"]));
  // One pair of helpers (placeMeta + placeRatingHtml) writes what a place is and its rating, for
  // the list's row and for the row under the map: the same place reads the same in both.
  const differ = near.filter(([id, meta, rate]) => rows[id] !== meta || (listRate[id] || "") !== rate)
    .map(([id, meta, rate]) => `${id}: map "${meta}" (${rate}) / list "${rows[id]}" (${listRate[id] || ""})`);
  check("under the map a place's row reads as its row in the list does", near.length >= 3 && differ.length === 0, differ.join("; ") || JSON.stringify(near));
  check("both say what it is in the list of subkinds' words, and show its rating",
    /^Café ?· ?Old Town, Harbor City$/.test(nearOf["cafe-one"] || "")
      && /^Café ?· ?Old Town, Harbor City$/.test(rows["cafe-one"] || "")
      && nearRate["cafe-one"] === "4.6" && listRate["cafe-one"] === "4.6"
      && /^Tourist office$/.test(nearOf["lone-office"] || "")
      && /^Beach ?·/.test(rows["east-beach"] || ""),
    JSON.stringify([nearOf["cafe-one"], nearRate["cafe-one"], rows["cafe-one"], listRate["cafe-one"], nearOf["lone-office"], rows["east-beach"]]));
  await t.look("places-list");
  await t.go(`/t/${trip}/?${Date.now()}#/p/cafe-one`);
  await appSettled(t.cdp, t.S);
  await t.waitFor(t.cdp, t.S, `document.querySelector(".pl-title .eyebrow") ? 1 : 0`, { label: "a place's page" });
  const line1 = await t.page(`document.querySelector(".pl-title .eyebrow").textContent.replace(/\\s+/g, " ").trim()`);
  await t.go(`/t/${trip}/?${Date.now()}#/p/lone-office`);
  await appSettled(t.cdp, t.S);
  await t.waitFor(t.cdp, t.S, `document.querySelector(".pl-title .h1") && /Lone Office/.test(document.querySelector(".pl-title .h1").textContent) ? 1 : 0`, { label: "the page of a place with no area" });
  const line2 = await t.page(`document.querySelector(".pl-title .eyebrow").textContent.replace(/\\s+/g, " ").trim()`);
  check("a place's page says its kind and its area, or its kind alone", /· Old Town, Harbor City$/.test(line1) && !/·/.test(line2) && line2.length > 0, JSON.stringify({ line1, line2 }));

  await theLine(t, "GL");

  section("4. a stored camera");
  const camKey = `wgp.map.cam@${trip}`;
  const store = async (v) => {
    // From a page of the site that has no map on it, so nothing writes the key after this.
    await t.go(`/account`);
    await t.sleep(900);
    await t.page(`(localStorage.setItem(${JSON.stringify(camKey)}, ${JSON.stringify(JSON.stringify(v))}), 1)`);
  };
  await store({ lng: 100, lat: 50, zoom: 6, bearing: 0, pitch: 0, at: Date.now() });
  await t.openMap("", "the map, after a camera a continent away was stored");
  c = await t.cam();
  check("a stored camera a continent away from the trip is not restored", !(Math.abs(c.lng - 100) < 1 && Math.abs(c.lat - 50) < 1), JSON.stringify(c));
  await store({ lng: -179.9, lat: -17.2, zoom: 9, bearing: 0, pitch: 0, at: Date.now() });
  await t.openMap("", "the map, after a camera near the trip was stored");
  c = await t.cam();
  check("one near the trip is, across the line too", Math.abs(c.lng + 179.9) < 0.01 && Math.abs(c.lat + 17.2) < 0.01 && Math.abs(c.zoom - 9) < 0.01, JSON.stringify(c));

  section("5. the trip's own offline map");
  check("until the trip has one, nothing asked for an archive", asked.head + asked.range + asked.whole === 0 && asked.old.length === 0, JSON.stringify(asked));
  check("…and the map says nothing about itself", (await t.note()) === null);
  const TILES_ON = `window.__wgpMapView.tiles() === true ? 1 : 0`;
  const keptIs = (len) => `caches.open("wgp-tiles-v1").then((c) => c.match(${JSON.stringify(ARCHIVE)})).then((r) => r ? r.blob() : null).then((bl) => bl && bl.size === ${len} ? 1 : 0)`;
  play.state = "ready"; play.ready = true;
  await t.openMap("", "the map of a trip that has an offline map");
  await t.waitFor(t.cdp, t.S, TILES_ON, { label: "the ground switched to the trip's tiles", timeout: 40000 });
  // Whoever gets there first: the shell keeps the whole archive without this screen (index.html,
  // map-keep.js) and the map then draws from the phone's copy, or the map reads by range while
  // the keep is still on its way. Either way it is the trip's address and the map's version.
  check("the trip's archive is asked for at the trip's address, whole by the keep or by range by the map, naming the map's version", asked.range + asked.whole >= 1 && asked.old.length === 0 && asked.versions.length > 0 && asked.versions.every((v) => v === "one"), JSON.stringify(asked));
  await t.waitFor(t.cdp, t.S, keptIs(play.bytes.length), { label: "the phone's own copy of the archive", timeout: 30000 });
  let kept = await t.cacheKeys();
  check("the phone keeps one copy, under the trip's bare address, marked with its version", Object.keys(kept).join() === ARCHIVE && kept[ARCHIVE] === play.bytes.length && asked.whole === 1 && (await t.keptVersion()) === "one", JSON.stringify({ kept, asked, v: await t.keptVersion() }));
  check("the size came from the trip: the server was not asked for it", asked.head === 0, JSON.stringify(asked));
  check("a map with nothing to say says nothing", (await t.note()) === null, JSON.stringify(await t.note()));
  await t.look("offline-map-on");

  let before = { ...asked };
  await t.openMap("", "the map again, the phone's copy in hand");
  await t.waitFor(t.cdp, t.S, TILES_ON, { label: "tiles from the phone's copy", timeout: 40000 });
  await t.sleep(6500);     // past the moment the copy would be fetched again, were it going to be
  check("the second time the map reads the phone's copy: nothing asked of the server", asked.range === before.range && asked.whole === before.whole && asked.head === before.head, JSON.stringify({ before, asked }));
  check("the map on screen is that version", (await t.view(`return v.mapVersion();`)) === "one");

  // The trip's map is cut again while this map is open.
  play.bytes = emptyArchive(9000); play.version = "two";
  before = { ...asked };
  await t.refresh();
  await t.waitFor(t.cdp, t.S, `window.__wgpMapView.mapVersion() === "two" ? 1 : 0`, { label: "the open map moved to the new version", timeout: 40000 });
  await t.waitFor(t.cdp, t.S, keptIs(play.bytes.length), { label: "the new archive on the phone", timeout: 30000 });
  kept = await t.cacheKeys();
  check("a map cut again is read at once, fetched once, and replaces the phone's copy", asked.whole === before.whole + 1 && kept[ARCHIVE] === play.bytes.length && Object.keys(kept).length === 1 && (await t.keptVersion()) === "two"
    && asked.versions.slice(before.versions.length).every((v) => v === "two"), JSON.stringify({ kept, before, asked }));

  await t.cdp.send("Network.setBlockedURLs", { urls: ["*/api/*"] }, t.S);
  before = { ...asked };
  await t.openMap("", "the map with the API out of reach");
  await t.waitFor(t.cdp, t.S, TILES_ON, { label: "tiles with the API out of reach", timeout: 40000 });
  check("with the API out of reach the map still draws the trip's tiles, from the phone's copy", asked.range === before.range && asked.whole === before.whole);
  await t.look("offline-map-no-api");
  await t.cdp.send("Network.setBlockedURLs", { urls: [] }, t.S);

  play.state = "none"; play.ready = false;
  await t.refresh();
  await t.waitFor(t.cdp, t.S, `window.__wgpMapView.tiles() === false ? 1 : 0`, { label: "the ground drawn again, the trip's map gone" });
  check("a trip that no longer has a map goes back to the drawn ground", (await t.inStore(`return store.tiles();`)) === null);

  section("6. what the map says about itself");
  await t.page(`caches.delete("wgp-tiles-v1").then(() => 1)`);
  play.state = "cutting"; play.ready = false; play.version = "";
  before = { ...asked };
  await t.openMap("", "the map of a trip whose map is being made");
  await t.sleep(2500);
  let said = await t.note();
  check("a map being made: one line saying so, nothing to press, nothing asked of the server",
    !!said && said.kind === "cutting" && /is being made/.test(said.words) && said.acts.length === 0 && said.on && asked.range === before.range && (await t.view(`return v.tiles();`)) === false, JSON.stringify({ said, before, asked }));
  await t.look("map-being-made");
  play.state = "ready"; play.ready = true; play.version = "three"; play.bytes = emptyArchive(5000);
  if (PLANT === "slowdraw") await t.cdp.send("Emulation.setCPUThrottlingRate", { rate: 40 }, t.S);
  await t.refresh();
  await t.waitFor(t.cdp, t.S, TILES_ON, { label: "the map that was being made, arrived", timeout: 40000 });
  // The "arriving" line stays until the streets have drawn once (map.js S.drawn), which on a loaded machine is a while
  // after the tiles are switched on: read the line once they have (21 Nov: red under load in a gate, and once alone).
  await t.waitFor(t.cdp, t.S, `window.__wgpMapView.drawn() === true ? 1 : 0`, { label: "the arrived map's streets, drawn once", timeout: 40000 });
  check("when it arrives the map draws it without a reload, and the line goes", (await t.note()) === null && (await t.view(`return v.mapVersion();`)) === "three", JSON.stringify(await t.note()));
  if (PLANT === "slowdraw") await t.cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }, t.S);

  play.state = "failed"; play.ready = false; play.version = ""; play.note = "The map couldn't be made: the world build didn't answer. It is tried again when the trip's regions change.";
  await t.refresh();
  await t.waitFor(t.cdp, t.S, `document.querySelector('.mp-note[data-kind="failed"]') ? 1 : 0`, { label: "the note about a map that could not be made" });
  said = await t.note();
  check("a map that couldn't be made: the server's own sentence; the host is offered Try again, and OK", said.words === play.note && said.more === "" && said.acts.join("|") === "Try again|OK" && said.on && (await t.view(`return v.tiles();`)) === false, JSON.stringify(said));
  await t.look("map-failed");
  await t.tap('.mp-note [data-note="ok"]', "OK");
  check("OK puts it away", (await t.note()) === null);
  await t.openMap("", "the map again, after its note was put away");
  await t.sleep(1500);
  check("…and it stays away for that same note", (await t.note()) === null, JSON.stringify(await t.note()));
  play.note = "The map couldn't be made: today's limit of maps for this trip is reached. It is made tomorrow.";
  await t.refresh();
  await t.waitFor(t.cdp, t.S, `document.querySelector('.mp-note[data-kind="failed"]') ? 1 : 0`, { label: "a new note" });
  check("a different sentence is said", (await t.note()).words === play.note);

  // The host asks for it again. Three answers, each said in words under the sentence.
  const failedNote = play.note;
  play.cut = "server";
  await t.tap('.mp-note [data-note="again"]', "Try again");
  await t.waitFor(t.cdp, t.S, `/doesn't make maps/.test((document.querySelector(".mp-note-more") || { textContent: "" }).textContent) ? 1 : 0`, { label: "the server's refusal, in its words" });
  said = await t.note();
  check("Try again, refused: ONE POST to the trip's tiles/cut, and the server's own sentence under the note, which stays with both buttons",
    asked.cut.join() === "POST" && said.words === failedNote && /^This site doesn't make maps/.test(said.more) && said.acts.join("|") === "Try again|OK" && said.on, JSON.stringify({ said, cut: asked.cut }));
  await t.look("map-failed-refused");
  play.cut = "offline";
  await t.tap('.mp-note [data-note="again"]', "Try again, with no signal");
  await t.waitFor(t.cdp, t.S, `/^No signal/.test((document.querySelector(".mp-note-more") || { textContent: "" }).textContent) ? 1 : 0`, { label: "no signal, said" });
  said = await t.note();
  check("Try again with no signal: said in words, nothing put away", said.more === "No signal. Try again when there is some." && said.words === failedNote && said.acts.join("|") === "Try again|OK", JSON.stringify(said));
  play.cut = "ok";
  await t.tap('.mp-note [data-note="again"]', "Try again, and the server asks");
  await t.waitFor(t.cdp, t.S, `document.querySelector('.mp-note[data-kind="cutting"]') ? 1 : 0`, { label: "the map being made again", timeout: 30000 });
  said = await t.note();
  check("Try again, taken: the card turns to the map being made, by itself, with nothing to press", asked.cut.join() === "POST,POST,POST" && /is being made/.test(said.words) && said.more === "" && said.acts.length === 0, JSON.stringify({ said, cut: asked.cut }));
  // …and it fails again, with the sentence it failed with before: said again, no stale answer under it.
  play.state = "failed"; play.note = failedNote; play.cut = "server";
  await t.refresh();
  await t.waitFor(t.cdp, t.S, `document.querySelector('.mp-note[data-kind="failed"]') ? 1 : 0`, { label: "the same failure, again" });
  said = await t.note();
  check("failing again with the same sentence is said again, with no answer left over from the last try", said.words === failedNote && said.more === "" && said.acts.join("|") === "Try again|OK", JSON.stringify(said));
  // A cut that failed keeps the map before it.
  play.ready = true; play.version = "three";
  await t.refresh();
  await t.waitFor(t.cdp, t.S, TILES_ON, { label: "the last map, kept through a failed cut", timeout: 40000 });
  // Both settle a moment after the tiles show (on a loaded machine, more): read them until they
  // agree or ten seconds pass, and say what was there.
  let lastKept = null;
  for (const until = Date.now() + 10000; ;) {
    lastKept = { words: (await t.note()).words, version: await t.view(`return v.mapVersion();`) };
    if ((lastKept.words === play.note && lastKept.version === "three") || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("a failed cut with the last map kept: the map is drawn AND the sentence said", lastKept.words === play.note && lastKept.version === "three", JSON.stringify(lastKept));
  play.state = "ready"; play.note = "The Coast was left out of the map to keep it within what a phone holds.";
  await t.refresh();
  await t.waitFor(t.cdp, t.S, `document.querySelector('.mp-note[data-kind="note"]') ? 1 : 0`, { label: "the note of a ready map" });
  said = await t.note();
  check("a ready map's note (a region left out) is said once, with OK", said.words === play.note && said.acts.join() === "OK", JSON.stringify(said));
  await t.look("map-note");
  await t.tap('.mp-note [data-note="ok"]', "OK");
  play.note = "";

  section("7. a map too big to keep without asking");
  await t.page(`caches.delete("wgp-tiles-v1").then(() => 1)`);
  play.source = "upload"; play.version = "big-one"; play.says = 60 * 1024 * 1024;
  before = { ...asked };
  await t.openMap("", "the map of a trip with a big uploaded map");
  await t.waitFor(t.cdp, t.S, TILES_ON, { label: "the big map, read over the network", timeout: 40000 });
  await t.waitFor(t.cdp, t.S, `document.querySelector('.mp-note[data-kind="keep"]') ? 1 : 0`, { label: "the question about keeping it", timeout: 30000 });
  said = await t.note();
  kept = await t.cacheKeys();
  check("it is drawn, NOT kept, and the map asks, with the size", /60 MB/.test(said.words) && /Keep it on this phone/.test(said.words) && said.acts.join("|") === "Keep it|Not now" && said.on && Object.keys(kept).length === 0 && asked.whole === before.whole, JSON.stringify({ said, kept, asked }));
  await t.look("map-keep-ask");
  await t.tap('.mp-note [data-note="skip"]', "Not now");
  await t.sleep(5000);
  kept = await t.cacheKeys();
  check("Not now: nothing is kept and the question goes", (await t.note()) === null && Object.keys(kept).length === 0 && asked.whole === before.whole, JSON.stringify({ kept, asked }));
  await t.openMap("", "the map again, after Not now");
  await t.waitFor(t.cdp, t.S, TILES_ON, { label: "the big map again", timeout: 40000 });
  await t.sleep(6500);
  check("…and it is not asked again for that map", (await t.note()) === null && asked.whole === before.whole, JSON.stringify(await t.note()));
  play.version = "big-two";
  await t.refresh();
  await t.waitFor(t.cdp, t.S, `document.querySelector('.mp-note[data-kind="keep"]') ? 1 : 0`, { label: "the question again, for a new big map", timeout: 40000 });
  await t.tap('.mp-note [data-note="keep"]', "Keep it");
  await t.waitFor(t.cdp, t.S, keptIs(play.bytes.length), { label: "the big map kept on the person's word", timeout: 30000 });
  check("a new big map asks again; Keep it keeps it and the question goes", (await t.note()) === null && (await t.keptVersion()) === "big-two" && asked.whole === before.whole + 1, JSON.stringify({ note: await t.note(), asked }));
  play.source = "cut"; play.says = 0; play.version = "four";

  section("8. an archive that will not open, and a phone from before");
  play.state = "ready"; play.ready = true; play.broken = true;
  await t.page(`caches.delete("wgp-tiles-v1").then(() => 1)`);
  await t.openMap("", "the map of a trip whose archive will not open");
  await t.sleep(5000);
  before = { ...asked };
  check("an archive that will not open leaves the drawn ground", (await t.view(`return v.tiles();`)) === false && before.range >= 1, JSON.stringify(before));
  for (let i = 0; i < 3; i++) {
    const add = await host.call("PUT", `${AT}/places`, { places: [{ id: `kiosk-${i}`, name: `Kiosk ${i + 1}`, kind: "practical", subkind: "convenience", why: "Water on the way.", area: "coast" }] });
    if (add.status !== 200) throw new Error(`adding a place: ${add.status} ${add.text.slice(0, 200)}`);
    await t.refresh();
    await t.sleep(1200);
  }
  // The map looks once. The keep (map-keep.js) tries a map twice in a visit, its second try on
  // a later change of the trip, and then lets it be: so three asks at most, and after them a
  // change of the trip asks nothing.
  const settled = { ...asked, versions: [...asked.versions] };
  for (let i = 0; i < 3; i++) {
    const again = await host.call("PUT", `${AT}/places`, { places: [{ id: `kiosk-${i}`, name: `Kiosk ${i + 1}`, kind: "practical", subkind: "convenience", why: "Water, and fruit.", area: "coast" }] });
    if (again.status !== 200) throw new Error(`changing a place: ${again.status} ${again.text.slice(0, 200)}`);
    await t.refresh();
    await t.sleep(1200);
  }
  const fours = asked.versions.filter((v) => v === "four").length;
  check("and it is not asked for again on every change of the trip: the map looks once, the keep tries twice, and three more changes ask nothing",
    fours >= 1 && fours <= 3 && asked.range === settled.range && asked.head === settled.head && asked.whole === settled.whole && asked.whole === before.whole
    && (await t.inStore(`return store.places().length;`)) === 8, JSON.stringify({ before, settled, asked }));
  play.broken = false;

  // A phone from before a map belonged to a trip: its one archive, at the old address.
  const plant = async (oldTrip) => {
    await t.go(`/account`);
    await t.sleep(900);
    await t.page(`(async () => {
      await caches.delete("wgp-tiles-v1");
      const c = await caches.open("wgp-tiles-v1");
      const bytes = Uint8Array.from(atob(${JSON.stringify(play.bytes.toString("base64"))}), (ch) => ch.charCodeAt(0));
      await c.put("/tiles/old-map.pmtiles", new Response(bytes, { status: 200, headers: { "Content-Type": "application/octet-stream", "ETag": '"old"' } }));
      localStorage.setItem("wgp.old-trip", ${JSON.stringify(oldTrip)});
      return 1; })()`);
  };
  await plant("some-other-trip");
  await t.cdp.send("Network.setBlockedURLs", { urls: [`*${ARCHIVE}*`] }, t.S);
  await t.openMap("", "the map on a phone whose old archive was another trip's");
  await t.sleep(5000);
  kept = await t.cacheKeys();
  check("an old archive that was another trip's is left alone, and is not this trip's map", Object.keys(kept).join() === "/tiles/old-map.pmtiles" && (await t.view(`return v.tiles();`)) === false, JSON.stringify(kept));
  await plant(trip);
  await t.openMap("", "the map on a phone from before, this trip's");
  await t.waitFor(t.cdp, t.S, `window.__wgpMapView.tiles() === true ? 1 : 0`, { label: "tiles from the archive the phone kept before", timeout: 40000 });
  kept = await t.cacheKeys();
  check("a phone from before keeps its old archive as this trip's: moved to the trip's address, drawn with the server out of reach",
    Object.keys(kept).join() === ARCHIVE && kept[ARCHIVE] === play.bytes.length, JSON.stringify(kept));
  await t.cdp.send("Network.setBlockedURLs", { urls: [] }, t.S);
  await t.page(`(localStorage.removeItem("wgp.old-trip"), 1)`);
  check("no request ever went to an archive's old address", asked.old.length === 0, asked.old.join(" "));

  allErrors.push(...b.pageErrors.map((e) => `GL: ${e}`));
  await b.done(); b = null;

  // ═══ the flat engine ═════════════════════════════════════════════════════════════════════
  play.state = "none"; play.ready = false;
  t = await open(false);
  await theLine(t, "flat");
  await t.openMap("", "the flat map");
  check("flat: the map's regions are the trip's", (await t.view(`return v.regions().map((r) => r.name).join("|");`)) === "Harbor City|The Islands|The Coast");
  sits(await t.layout(), "flat");

  section("3b. a region's name is worn by one disc, or by none");
  {
    // Four more places in The Coast: two pairs, 0.6° of latitude apart (67 km).
    const MORE = [
      { id: "cove-one", name: "Cove One", kind: "sight", subkind: "beach", why: "A swim.", area: "coast", lat: 40.0, lng: -8.0 },
      { id: "cove-two", name: "Cove Two", kind: "sight", subkind: "beach", why: "A swim.", area: "coast", lat: 40.01, lng: -8.0 },
      { id: "cape-one", name: "Cape One", kind: "sight", subkind: "viewpoint", why: "The view.", area: "coast", lat: 40.6, lng: -8.0 },
      { id: "cape-two", name: "Cape Two", kind: "sight", subkind: "viewpoint", why: "The view.", area: "coast", lat: 40.61, lng: -8.0 },
    ];
    const put = await host.call("PUT", `${AT}/places`, { places: [...PLACES, ...MORE] });
    check("the server takes four more places", put.status === 200, `${put.status} ${put.text.slice(0, 200)}`);
    await t.refresh();
    await t.waitFor(t.cdp, t.S, `import("/js/store.js").then(({ store }) => ["cove-one", "cove-two", "cape-one", "cape-two"].every((id) => store.places().some((p) => p.id === id)) ? 1 : 0)`, { label: "the four more places on the phone" });
    const discs = async () => JSON.parse(await t.page(`JSON.stringify([...document.querySelectorAll(".mp-cluster")].map((n) => ({ ids: (n.dataset.ids || "").split(",").sort().join(), name: n.querySelector(".mp-cluster-name").hidden ? "" : n.querySelector(".mp-cluster-name").textContent.trim() })))`));
    // Zoom 8 at 40° north is 233 m to the pixel: the pairs are 287 px apart, each pair one disc.
    await t.jump({ lng: -8.0, lat: 40.3, zoom: 8 });
    let d = await discs();
    const cove = d.find((c) => c.ids === "cove-one,cove-two"), cape = d.find((c) => c.ids === "cape-one,cape-two");
    check("two discs of one region on screen: neither wears the region's name", !!cove && !!cape && cove.name === "" && cape.name === "", JSON.stringify(d));
    await t.look("region-two-discs");
    // Zoom 4 is 3.7 km to the pixel: the pairs are 18 px apart, one disc of four.
    await t.jump({ lng: -8.0, lat: 40.3, zoom: 4 });
    d = await discs();
    const all4 = d.find((c) => c.ids === "cape-one,cape-two,cove-one,cove-two");
    check("drawn together into one disc, it wears the region's name", !!all4 && all4.name === "The Coast", JSON.stringify(d));
    await t.look("region-one-disc");
  }
  allErrors.push(...b.pageErrors.map((e) => `flat: ${e}`));
  await b.done(); b = null;

  section("8. a map that couldn't be made, seen by somebody who doesn't host the trip");
  play.state = "failed"; play.ready = false; play.version = ""; play.source = "cut"; play.says = 0; play.cut = "server";
  play.note = "The map couldn't be made: the world build didn't answer. It is tried again when the trip's regions change.";
  {
    const before = asked.cut.length;
    t = await open(false, other);
    await t.openMap("", "the map, as the other person");
    await t.waitFor(t.cdp, t.S, `document.querySelector('.mp-note[data-kind="failed"]') ? 1 : 0`, { label: "the note, on the other person's phone" });
    const theirs = await t.note();
    check("they read the sentence and WHO can ask again (the host, by name), with OK alone", theirs.words === play.note && theirs.more === "Mara Voss hosts this trip and can ask for it to be made again."
      && theirs.acts.join("|") === "OK" && theirs.on && asked.cut.length === before, JSON.stringify(theirs));
    await t.look("map-failed-not-the-host");
    await t.tap('.mp-note [data-note="ok"]', "OK");
    check("their OK puts it away", (await t.note()) === null);
    allErrors.push(...b.pageErrors.map((e) => `the other person: ${e}`));
  }

  section("the page threw nothing");
  check("no page errors in any browser", allErrors.length === 0, allErrors.slice(0, 5).join(" | "));
} catch (e) {
  fail++; failures.push("the run itself");
  console.log(`\n  FAIL  the check stopped: ${e && e.stack ? e.stack : e}`);
} finally {
  try { if (b) await b.done(); } catch { /* already gone */ }
  await server.stop();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(failures.map((f) => `  - ${f}`).join("\n"));
process.exit(fail ? 1 : 0);
