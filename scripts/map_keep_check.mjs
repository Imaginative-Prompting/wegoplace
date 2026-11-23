#!/usr/bin/env node
/* A trip's map is on the phone after the trip's first open with signal, with the map screen
 * never opened (public/js/map-keep.js, called by the shell in index.html). In a real browser,
 * on a server of its own.
 *
 *   python3 <channel>/pipelines/lyric-video/tools/gpu.py run --kind parallel --who <session> \
 *     --label "wegoplace map_keep_check.mjs" -- node scripts/map_keep_check.mjs
 *
 * WGP_SHOTS=<folder> also writes pictures to look at, at 320, 390, 768 and 1440 wide in both
 * themes. Nothing is asserted from them.
 *
 * The server is this check's own (checks/lib/server.mjs: an empty database, a port of its
 * own). One made-up person makes four trips. The check plays the part of the server that
 * holds maps, in the browser's network layer: it adds `tiles` to each trip's snapshot,
 * answers GET|HEAD /api/trips/<id>/tiles with a small valid archive of no tiles, and answers
 * /tiles/fonts/<font>/<range>.pbf with a small glyph file. Every such request is counted.
 *
 * The harness's browser runs with the service worker out of the way (scripts/lib/
 * standalone_cdp.mjs), so what is held about the labels is what the page itself keeps: each
 * glyph range, in the cache the service worker answers map furniture from, under the address
 * the service worker would look it up by. That a map then DRAWS its names with no signal, the
 * worker on, real fonts and a real cut, is checks/map/draw.mjs's to show (off the gate: it
 * reads a world build over the network).
 *
 * WHAT IT HOLDS
 *   1. A TRIP OPENED ONCE WITH SIGNAL, THE MAP NEVER OPENED: its archive is on the phone,
 *      whole, fetched once, after the trip's own data had answered; every glyph range the
 *      trip's map lists is on the phone for every font the style names; one passing line
 *      said so, once; nothing asked the person anything.
 *   2. OPENED AGAIN: nothing is fetched twice, and the line is not said again.
 *   3. THE SERVER OUT OF REACH (its API and its fonts), AND NOW THE MAP IS OPENED, for the
 *      first time: it draws the trip's tiles from the phone's copy, with not one request
 *      reaching the archive's address.
 *   4. THE TRIP'S MAP IS CUT AGAIN: the new one replaces the kept one the same way.
 *   5. A MAP SOMEBODY UPLOADED, WHICH LISTS NO FONTS: kept, with the Latin ranges of every
 *      font; and the first trip's map is still on the phone beside it.
 *   6. A PHONE SHORT OF ROOM: the map is not fetched, the phone says so in words, the trip
 *      itself is kept, and no other trip's map was pushed out; the map screen says the same
 *      until it is put away.
 *   7. WHAT ASKS FIRST STILL ASKS FIRST: a map over the budget, and a browser set to save
 *      data, are not fetched in the background; the map screen asks, and "Keep it" keeps it.
 *
 * PLANTED (by hand, each must turn this red): the shell's keepTheMap() never called (the keep
 * waits for the map screen): 1 fails. keepGlyphs() given only the fonts a layer names
 * outright: the font count in 1 fails.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { startServer } from "../checks/lib/server.mjs";
import { Person } from "../checks/lib/person.mjs";
import { freeLoopbackPort, ownServer } from "./lib/browser.mjs";
import { emptyArchive } from "./lib/empty_archive.mjs";

const server = await startServer({ name: "map-keep", port: await freeLoopbackPort() });
ownServer(server.origin);

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? "   — " + String(detail).slice(0, 300) : ""}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? "   -> " + String(detail).slice(0, 900) : ""}`); }
}
const section = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);
const SHOTS = process.env.WGP_SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// The fonts the app's style names, read the way the app reads them (no browser needed).
globalThis.location ??= { origin: server.origin };
const keep = await import("../public/js/map-keep.js");
const basemaps = await import("../public/vendor/basemaps/basemaps.mjs");
const FONTS = keep.fontStacks(keep.styleLayers(basemaps, "light"));
const KEEPING = keep.KEEPING_WORDS;

// A glyph file is a protocol buffer whose first field is the font's name (field 1, bytes).
const GLYPHS = Buffer.concat([Buffer.from([0x0a, 0x04]), Buffer.from("font")]);

let b = null;
try {
  await server.start();
  const host = new Person(server.origin, "Mara Voss");
  await host.signUp();
  const makeTrip = async (name) => {
    const made = await host.post("/api/trips", { name, default_tz: "Europe/Lisbon" });
    const id = made.json && made.json.trip && made.json.trip.id;
    if (!id) throw new Error(`making the trip "${name}": ${made.status} ${made.text.slice(0, 200)}`);
    const put = await host.call("PUT", `/api/trips/${id}/places`, { places: [
      { id: "cafe-one", name: `${name} Cafe`, kind: "food", subkind: "cafe", why: "Breakfast on the first day.", lat: 38.71, lng: -9.14 },
    ] });
    if (put.status !== 200) throw new Error(`a place on "${name}": ${put.status} ${put.text.slice(0, 200)}`);
    return id;
  };

  // What the check plays of the server, for each trip: what the trip says about its map
  // (docs/API.md, "The trip's map") and the archive behind it.
  //   says     the size the snapshot CLAIMS (an uploaded map over the budget); 0: the archive's own
  //   asked    what was asked of the archive's address; snapAt/wholeAt: when (ms) the trip's
  //            snapshot first answered and when the whole archive was first asked for
  const plays = new Map();
  const play = (id, more) => {
    const p = { id, state: "ready", ready: true, version: "one", note: "", source: "cut", glyphs: ["0-255", "256-511", "7680-7935"],
      bytes: emptyArchive(4000), says: 0, asked: { head: 0, range: 0, whole: 0, versions: [] }, snapAt: 0, wholeAt: 0, ...more };
    plays.set(id, p);
    return p;
  };
  const tilesOf = (p) => (!p.ready ? null
    : { state: p.state, version: p.version, bytes: p.says || p.bytes.length, at: 1790000000, source: p.source, note: p.note, glyphs: p.glyphs, ready: p.ready });
  const glyphAsks = new Map();          // "<font>/<range>" → times asked
  const glyphTotal = () => [...glyphAsks.values()].reduce((a, n) => a + n, 0);
  let offline = false;

  const A = play(await makeTrip("Harbor"));
  const B = play(await makeTrip("Upload"), { source: "upload", glyphs: [], bytes: emptyArchive(6000), version: "u1" });
  const C = play(await makeTrip("Tight"), { bytes: emptyArchive(5000), version: "c1" });
  const D = play(await makeTrip("Large"), { source: "upload", glyphs: [], bytes: emptyArchive(7000), version: "d1", says: 60 * 1024 * 1024 });
  const E = play(await makeTrip("Saver"), { bytes: emptyArchive(8000), version: "e1" });
  const archiveOf = (p) => `/api/trips/${p.id}/tiles`;

  const { boot, evalIn, waitFor, appSettled, sleep } = await import("./lib/standalone_cdp.mjs");
  b = await boot({ vw: 390, vh: 844, dsf: 1, gl: true });
  const { cdp, S } = b;
  const page = (expr) => evalIn(cdp, S, expr);
  for (const name of ["s2", "wgp_session", "wgp_who"]) await cdp.send("Network.deleteCookies", { name, url: server.origin }, S);
  await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_session", value: host.jar.cookies.get("wgp_session"), httpOnly: true, sameSite: "Lax" }, S);
  const who = host.jar.cookies.get("wgp_who");
  if (who) await cdp.send("Network.setCookie", { url: server.origin, name: "wgp_who", value: who, sameSite: "Lax" }, S);

  // Before any of the page's own scripts, on every load: every sentence the passing message
  // shows is written down (it is gone in five seconds); and the two things about the phone
  // the check plays, from sessionStorage so they hold across loads: how much room it has,
  // and whether the browser is set to save data.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const saidKey = "check.said";
    // A sentence is written down when it comes onto the screen: once for each time it is
    // shown, however many times the node is touched while it shows.
    let showing = new Set();
    const note = () => {
      const n = document.getElementById("toast");
      const words = n && !n.hidden ? n.innerText.trim() : "";
      const now = new Set(words.split("\\n").map((s) => s.trim()).filter(Boolean));
      const fresh = [...now].filter((line) => !showing.has(line));
      showing = now;
      if (!fresh.length) return;
      sessionStorage.setItem(saidKey, JSON.stringify([...JSON.parse(sessionStorage.getItem(saidKey) || "[]"), ...fresh]));
    };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
    const room = sessionStorage.getItem("check.room");
    if (room && navigator.storage) navigator.storage.estimate = async () => JSON.parse(room);
    if (sessionStorage.getItem("check.saveData")) Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
  })();` }, S);

  await cdp.send("Fetch.enable", { patterns: [
    { urlPattern: "*/api/trips/*", requestStage: "Request" },
    { urlPattern: "*/api/trips/*", requestStage: "Response" },
    { urlPattern: "*/tiles/fonts/*", requestStage: "Request" },
  ] }, S);
  cdp.on(async (m) => {
    if (m.sessionId !== S || m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    const u = new URL(request.url);
    const atResponse = m.params.responseStatusCode !== undefined || m.params.responseErrorReason !== undefined;
    const pass2 = () => cdp.send("Fetch.continueRequest", { requestId }, S);
    try {
      if (offline && !atResponse) { await cdp.send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" }, S); return; }
      const font = /^\/tiles\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/.exec(u.pathname);
      if (font) {
        const key = `${decodeURIComponent(font[1])}/${font[2]}`;
        glyphAsks.set(key, (glyphAsks.get(key) || 0) + 1);
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/x-protobuf" }, { name: "Content-Length", value: String(GLYPHS.length) }],
          body: GLYPHS.toString("base64") }, S);
        return;
      }
      const tiles = /^\/api\/trips\/([^/]+)\/tiles$/.exec(u.pathname);
      const p = plays.get(tiles ? tiles[1] : (/^\/api\/trips\/([^/]+)$/.exec(u.pathname) || [])[1]);
      if (tiles && p && !atResponse) {
        p.asked.versions.push(u.searchParams.get("v"));
        const size = p.bytes.length;
        const common = [{ name: "Content-Type", value: "application/octet-stream" }, { name: "Accept-Ranges", value: "bytes" },
          { name: "ETag", value: `"${p.version}"` }, { name: "Cache-Control", value: "private, no-cache" }];
        if (!p.ready) {
          await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 404, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from('{"error":"no map"}').toString("base64") }, S);
          return;
        }
        if (request.method === "HEAD") {
          p.asked.head++;
          await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [...common, { name: "Content-Length", value: String(size) }] }, S);
          return;
        }
        const range = Object.entries(request.headers).find(([k]) => k.toLowerCase() === "range");
        const mm = range && /^bytes=(\d+)-(\d+)$/.exec(range[1]);
        if (!mm) {
          p.asked.whole++;
          if (!p.wholeAt) p.wholeAt = Date.now();
          await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [...common, { name: "Content-Length", value: String(size) }],
            body: p.bytes.toString("base64") }, S);
          return;
        }
        p.asked.range++;
        const from = Number(mm[1]), to = Math.min(Number(mm[2]), size - 1);
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 206,
          responseHeaders: [...common, { name: "Content-Range", value: `bytes ${from}-${to}/${size}` }, { name: "Content-Length", value: String(to - from + 1) }],
          body: p.bytes.subarray(from, to + 1).toString("base64") }, S);
        return;
      }
      // The trip's snapshot: only a 200 with a body has anything to add `tiles` to.
      if (!tiles && p && atResponse && m.params.responseStatusCode === 200 && request.method === "GET") {
        const got = await cdp.send("Fetch.getResponseBody", { requestId }, S);
        const snap = JSON.parse(got.base64Encoded ? Buffer.from(got.body, "base64").toString("utf8") : got.body);
        if (snap && snap.trip) { snap.tiles = tilesOf(p); if (!p.snapAt) p.snapAt = Date.now(); }
        const headers = (m.params.responseHeaders || []).filter((h) => !/^content-(length|encoding)$/i.test(h.name));
        await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: headers,
          body: Buffer.from(JSON.stringify(snap)).toString("base64") }, S);
        return;
      }
      await pass2();
    } catch (e) {
      console.log(`  (the check's own answer failed: ${u.pathname} ${e.message})`);
      try { await pass2(); } catch { /* already answered */ }
    }
  });

  // ── what every part below reads ───────────────────────────────────────────────────────────
  const go = async (address) => { await cdp.send("Page.navigate", { url: `${server.origin}${address}` }, S); await sleep(300); };
  // A trip, on its first screen. The map screen is not opened.
  const openTrip = async (p, label) => {
    await go(`/t/${p.id}/?${Date.now()}#/`);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `import("/js/store.js").then(({ store }) => store.places().length === 1 ? 1 : 0)`, { label: `${label}: the trip's own data on the phone` });
  };
  const openMap = async (p, label) => {
    await go(`/t/${p.id}/?${Date.now()}#/places?view=map`);
    await appSettled(cdp, S);
    await waitFor(cdp, S, `document.querySelector(".mp-root") && window.__wgpMapView ? 1 : 0`, { label });
    await waitFor(cdp, S, `window.__wgpMapView.engine() === "gl" ? 1 : 0`, { label: `${label}: the GL engine`, timeout: 60000 });
    await sleep(900);
  };
  // The archives the phone keeps: { "<address>": { size, version } }.
  const keptMaps = async () => JSON.parse(await page(`(async () => {
    const c = await caches.open("wgp-tiles-v1"); const out = {};
    for (const rq of await c.keys()) { const r = await c.match(rq); out[new URL(rq.url).pathname + new URL(rq.url).search] = { size: (await r.blob()).size, version: r.headers.get("X-Map-Version") }; }
    return JSON.stringify(out); })()`));
  const keptIs = (p) => `caches.open("wgp-tiles-v1").then((c) => c.match(${JSON.stringify(archiveOf(p))})).then((r) => r ? r.blob().then((bl) => bl.size === ${p.bytes.length} && r.headers.get("X-Map-Version") === ${JSON.stringify(p.version)} ? 1 : 0) : 0)`;
  // The glyph ranges the phone keeps, as "<font>/<range>", read from the cache the service
  // worker answers map furniture from, by the addresses it would look them up by.
  const keptGlyphs = async () => JSON.parse(await page(`(async () => {
    const c = await caches.open("wegoplace-tiles-v1"); const out = [];
    for (const rq of await c.keys()) { const u = new URL(rq.url); const m = /^\\/tiles\\/fonts\\/([^/]+)\\/(\\d+-\\d+)\\.pbf$/.exec(u.pathname);
      if (m && !u.search && u.origin === location.origin) out.push(decodeURIComponent(m[1]) + "/" + m[2]); }
    return JSON.stringify(out.sort()); })()`));
  const wanted = (ranges) => FONTS.flatMap((f) => ranges.map((r) => `${f}/${r}`)).sort();
  const glyphsAre = (ranges) => `caches.open("wegoplace-tiles-v1").then((c) => c.keys()).then((k) => k.length >= ${FONTS.length * ranges.length} ? 1 : 0)`;
  const saidAll = async () => JSON.parse(await page(`sessionStorage.getItem("check.said") || "[]"`));
  const count = (list, words) => list.filter((w) => w === words).length;
  const note = async () => JSON.parse(await page(`(() => { const n = document.querySelector(".mp-note"); if (!n || n.hidden) return "null";
    return JSON.stringify({ kind: n.dataset.kind, words: n.querySelector(".mp-note-t").textContent, acts: [...n.querySelectorAll("[data-note]")].map((x) => x.textContent) }); })()`));
  const tap = async (sel, label = sel) => {
    const got = await page(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return 0; n.click(); return 1; })()`);
    if (got !== 1) throw new Error(`tap: ${label} is not there`);
    await sleep(500);
  };
  // Pictures to look at: four widths, both themes. `quick` for a passing message, which is on
  // the screen for a few seconds only (the map needs longer to redraw at a new size).
  const look = async (name, { quick = false } = {}) => {
    if (!SHOTS) return;
    const was = JSON.parse(await page(`JSON.stringify(["data-theme", "data-lum"].map((a) => document.documentElement.getAttribute(a)))`));
    for (const theme of ["light", "void"]) {
      await page(`(document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)}), document.documentElement.setAttribute("data-lum", ${JSON.stringify(theme === "void" ? "dark" : "light")}), 1)`);
      for (const w of [390, 320, 768, 1440]) {
        await b.metrics(w, 844, 1);
        await sleep(quick ? 150 : 500);
        await b.shot(path.join(SHOTS, `${name}-${w}-${theme}.png`));
      }
    }
    await page(`(${JSON.stringify(was)}.forEach((v, i) => { const a = ["data-theme", "data-lum"][i]; if (v === null) document.documentElement.removeAttribute(a); else document.documentElement.setAttribute(a, v); }), 1)`);
    await b.metrics(390, 844, 1);
    await sleep(300);
  };
  // The server's API and its fonts out of reach: every such request fails. (Not the whole
  // network: this browser has no service worker to hand the page its own files.)
  const reach = async (on) => {
    offline = !on;
    await cdp.send("Network.setBlockedURLs", { urls: on ? [] : ["*/api/*", "*/tiles/*"] }, S);
  };
  const QUIET = 7000;   // past the page's quiet moment and a keep's whole run, were there going to be one

  check("the style names its fonts outright, by a rule, and for a script inside a name: all are read",
    FONTS.length === 4 && FONTS.includes("Noto Sans Regular") && FONTS.includes("Noto Sans Medium") && FONTS.includes("Noto Sans Italic") && FONTS.some((f) => /Devanagari/.test(f)), FONTS.join(" | "));

  // ═══ 1 ═══════════════════════════════════════════════════════════════════════════════════
  section("1. a trip opened once with signal, the map never opened");
  await openTrip(A, "the first trip");
  await waitFor(cdp, S, `(JSON.parse(sessionStorage.getItem("check.said") || "[]")).includes(${JSON.stringify(KEEPING)}) ? 1 : 0`, { label: "the line that says the map is being kept", timeout: 30000 });
  await sleep(300);
  await look("1-the-line", { quick: true });
  await waitFor(cdp, S, keptIs(A), { label: "the trip's archive on the phone, with the map screen never opened", timeout: 30000 });
  await waitFor(cdp, S, glyphsAre(A.glyphs), { label: "the map's glyph ranges on the phone", timeout: 30000 });
  await sleep(600);
  let maps = await keptMaps();
  check("the trip's archive is on the phone: whole, under the trip's bare address, marked with its version",
    Object.keys(maps).join() === archiveOf(A) && maps[archiveOf(A)].size === A.bytes.length && maps[archiveOf(A)].version === "one", JSON.stringify(maps));
  check("it was fetched once, whole, naming the map's version; its size came from the trip (no HEAD)",
    A.asked.whole === 1 && A.asked.range === 0 && A.asked.head === 0 && A.asked.versions.join() === "one", JSON.stringify(A.asked));
  check("the map screen was never opened", (await page(`document.querySelector(".mp-root") || window.__wgpMapView ? 1 : 0`)) === 0 && !/map/.test(await page(`location.hash`)));
  check("the archive was asked for after the trip's own data had answered", A.snapAt > 0 && A.wholeAt >= A.snapAt, `${A.wholeAt - A.snapAt} ms after the snapshot`);
  let glyphs = await keptGlyphs();
  check(`every range the map lists is on the phone for every font the style names (${FONTS.length} fonts × ${A.glyphs.length} ranges)`,
    JSON.stringify(glyphs) === JSON.stringify(wanted(A.glyphs)), `${glyphs.length} kept: ${glyphs.slice(0, 4).join(", ")}…`);
  check("each was asked for once", glyphTotal() === FONTS.length * A.glyphs.length && [...glyphAsks.values()].every((n) => n === 1), `${glyphTotal()} requests`);
  let said = await saidAll();
  check(`one passing line said what was happening, once: "${KEEPING}"`, count(said, KEEPING) === 1 && said.length === 1, JSON.stringify(said));
  check("nothing asks the person anything: the message has no button", (await page(`document.querySelectorAll("#toast button").length`)) === 0);
  await look("1-first-open");

  // ═══ 2 ═══════════════════════════════════════════════════════════════════════════════════
  section("2. opened again");
  let before = { whole: A.asked.whole, head: A.asked.head, range: A.asked.range, glyphs: glyphTotal() };
  await openTrip(A, "the first trip again");
  await sleep(QUIET);
  check("nothing is fetched twice: not the archive, not a glyph range",
    A.asked.whole === before.whole && A.asked.head === before.head && A.asked.range === before.range && glyphTotal() === before.glyphs, JSON.stringify({ before, asked: A.asked, glyphs: glyphTotal() }));
  said = await saidAll();
  check("the line is not said again", count(said, KEEPING) === 1, JSON.stringify(said));

  // ═══ 3 ═══════════════════════════════════════════════════════════════════════════════════
  section("3. the server out of reach, and now the map is opened");
  await reach(false);
  before = { whole: A.asked.whole, head: A.asked.head, range: A.asked.range, glyphs: glyphTotal() };
  await openMap(A, "the map, opened for the first time, with the server out of reach");
  await waitFor(cdp, S, `window.__wgpMapView.tiles() === true ? 1 : 0`, { label: "the ground drawn from the trip's tiles, with the server out of reach", timeout: 40000 });
  check("the map draws the trip's tiles, from the phone's copy", (await page(`window.__wgpMapView.mapVersion()`)) === "one");
  check("not one request reached the archive's address", A.asked.whole === before.whole && A.asked.head === before.head && A.asked.range === before.range, JSON.stringify(A.asked));
  check("the map has nothing to say about itself", (await note()) === null, JSON.stringify(await note()));
  await look("3-map-server-out-of-reach");
  await reach(true);

  // ═══ 4 ═══════════════════════════════════════════════════════════════════════════════════
  section("4. the trip's map is cut again");
  A.bytes = emptyArchive(9000); A.version = "two"; A.glyphs = ["0-255", "256-511", "7680-7935", "1024-1279"];
  before = { whole: A.asked.whole, glyphs: glyphTotal() };
  await openTrip(A, "the first trip, its map cut again");
  await waitFor(cdp, S, keptIs(A), { label: "the new archive on the phone, the map screen not opened", timeout: 30000 });
  await waitFor(cdp, S, glyphsAre(A.glyphs), { label: "the new map's glyph ranges on the phone", timeout: 30000 });
  await sleep(600);
  maps = await keptMaps();
  check("the new map replaced the kept one: one copy, the new version, fetched once",
    Object.keys(maps).join() === archiveOf(A) && maps[archiveOf(A)].version === "two" && maps[archiveOf(A)].size === A.bytes.length && A.asked.whole === before.whole + 1, JSON.stringify({ maps, asked: A.asked }));
  glyphs = await keptGlyphs();
  check("only the range the new map added was asked for, once for each font",
    JSON.stringify(glyphs) === JSON.stringify(wanted(A.glyphs)) && glyphTotal() === before.glyphs + FONTS.length, `${glyphTotal() - before.glyphs} requests`);
  said = await saidAll();
  check("the line was said for the new map, once", count(said, KEEPING) === 2, JSON.stringify(said));

  // ═══ 5 ═══════════════════════════════════════════════════════════════════════════════════
  section("5. a map somebody uploaded, which lists no fonts");
  before = { glyphs: glyphTotal() };
  await openTrip(B, "the trip with an uploaded map");
  await waitFor(cdp, S, keptIs(B), { label: "the uploaded map on the phone", timeout: 30000 });
  await sleep(1500);
  maps = await keptMaps();
  check("it is kept, and the first trip's map is still on the phone beside it",
    Object.keys(maps).sort().join() === [archiveOf(A), archiveOf(B)].sort().join() && maps[archiveOf(B)].version === "u1" && maps[archiveOf(A)].version === "two", JSON.stringify(maps));
  glyphs = await keptGlyphs();
  check("the Latin ranges of every font are on the phone (0-255 and 256-511), so its names draw with no signal",
    wanted(keep.LATIN).every((g) => glyphs.includes(g)), `${glyphs.length} kept`);
  check("they were on the phone already from the first trip: not one asked for again", glyphTotal() === before.glyphs, `${glyphTotal() - before.glyphs} requests`);
  // And on a phone that has only ever opened this trip.
  await page(`caches.delete("wegoplace-tiles-v1").then(() => caches.delete("wgp-tiles-v1")).then(() => { localStorage.clear(); return 1; })`);
  before = { glyphs: glyphTotal(), whole: B.asked.whole };
  await openTrip(B, "the trip with an uploaded map, on a phone that has nothing");
  await waitFor(cdp, S, keptIs(B), { label: "the uploaded map on the phone", timeout: 30000 });
  await waitFor(cdp, S, glyphsAre(keep.LATIN), { label: "the Latin ranges on the phone", timeout: 30000 });
  await sleep(600);
  glyphs = await keptGlyphs();
  check(`on a phone with nothing: exactly the Latin ranges, for every font (${FONTS.length} fonts × 2), each asked once`,
    JSON.stringify(glyphs) === JSON.stringify(wanted(keep.LATIN)) && glyphTotal() === before.glyphs + FONTS.length * 2 && B.asked.whole === before.whole + 1, `${glyphs.length} kept, ${glyphTotal() - before.glyphs} requests`);

  // ═══ 6 ═══════════════════════════════════════════════════════════════════════════════════
  section("6. a phone short of room");
  // Room for the trip, not for twice the map (what a keep wants before it starts).
  await page(`sessionStorage.setItem("check.room", JSON.stringify({ quota: 1000000, usage: 1000000 - ${C.bytes.length} })), 1`);
  const ROOM = keep.roomWords(C.bytes.length);
  await openTrip(C, "the trip on a phone short of room");
  await waitFor(cdp, S, `(JSON.parse(sessionStorage.getItem("check.said") || "[]")).includes(${JSON.stringify(ROOM)}) ? 1 : 0`, { label: "the phone saying it is short of room", timeout: 30000 });
  await sleep(300);
  await look("6-the-room-line", { quick: true });
  await sleep(1500);
  maps = await keptMaps();
  check("the map was not fetched", C.asked.whole === 0 && !maps[archiveOf(C)], JSON.stringify(C.asked));
  said = await saidAll();
  check(`the phone says so in words, once: "${ROOM}"`, count(said, ROOM) === 1, JSON.stringify(said.slice(-3)));
  check("the trip itself is kept: its place is on the phone", (await page(`import("/js/store.js").then(({ store }) => store.places().map((p) => p.name).join())`)) === "Tight Cafe");
  check("no other trip's map was pushed out", Object.keys(maps).join() === archiveOf(B) && maps[archiveOf(B)].version === "u1", JSON.stringify(maps));
  await look("6-short-of-room");
  await openMap(C, "the map on a phone short of room");
  await waitFor(cdp, S, `(() => { const n = document.querySelector(".mp-note"); return n && !n.hidden ? 1 : 0; })()`, { label: "the map saying it is short of room", timeout: 30000 });
  let n = await note();
  check("the map screen says the same, with an OK", !!n && n.kind === "room" && n.words === ROOM && n.acts.join() === "OK", JSON.stringify(n));
  await look("6-short-of-room-map");
  await tap('.mp-note [data-note="ok"]', "the note's OK");
  check("OK puts it away", (await note()) === null, JSON.stringify(await note()));
  await openMap(C, "the map again on a phone short of room");
  await sleep(QUIET);
  said = await saidAll();
  check("it stays away, and the passing line is not said again for this map", (await note()) === null && count(said, ROOM) === 1, JSON.stringify({ note: await note(), said: said.slice(-3) }));
  check("the map still reads the trip's tiles while there is signal (by range), and still nothing is kept", C.asked.range >= 1 && C.asked.whole === 0, JSON.stringify(C.asked));
  await page(`sessionStorage.removeItem("check.room"), 1`);

  // ═══ 7 ═══════════════════════════════════════════════════════════════════════════════════
  section("7. what asks first still asks first");
  const saidBefore = count(await saidAll(), KEEPING);
  await openTrip(D, "the trip whose uploaded map is over the budget");
  await sleep(QUIET);
  maps = await keptMaps();
  said = await saidAll();
  check("a map over the budget is not fetched in the background, and nothing is said in passing", D.asked.whole === 0 && !maps[archiveOf(D)] && count(said, KEEPING) === saidBefore, JSON.stringify({ asked: D.asked, said: said.slice(-3) }));
  await openMap(D, "the map of the trip whose map is over the budget");
  await waitFor(cdp, S, `(() => { const n = document.querySelector(".mp-note"); return n && !n.hidden ? 1 : 0; })()`, { label: "the map asking about a big map", timeout: 30000 });
  n = await note();
  check("the map screen asks, as before", !!n && n.kind === "keep" && /^This trip's map is 60 MB\./.test(n.words) && n.acts.join("|") === "Keep it|Not now", JSON.stringify(n));

  await page(`sessionStorage.setItem("check.saveData", "1"), 1`);
  await openTrip(E, "the trip on a browser set to save data");
  await sleep(QUIET);
  maps = await keptMaps();
  check("with the browser set to save data, the map is not fetched in the background", E.asked.whole === 0 && !maps[archiveOf(E)], JSON.stringify(E.asked));
  await openMap(E, "the map on a browser set to save data");
  await waitFor(cdp, S, `(() => { const n = document.querySelector(".mp-note"); return n && !n.hidden ? 1 : 0; })()`, { label: "the map asking, on a browser set to save data", timeout: 30000 });
  n = await note();
  check("the map screen asks, and says why", !!n && n.kind === "keep" && /^This browser is set to save data\. Keep this trip's map \(1 MB\) on this phone/.test(n.words) && n.acts.join("|") === "Keep it|Not now", JSON.stringify(n));
  await look("7-save-data-asks");
  await tap('.mp-note [data-note="keep"]', "Keep it");
  await waitFor(cdp, S, keptIs(E), { label: "the map kept on the person's word", timeout: 30000 });
  check('"Keep it" keeps it: fetched once, and the note is gone', E.asked.whole === 1 && (await note()) === null, JSON.stringify({ asked: E.asked, note: await note() }));
  await page(`sessionStorage.removeItem("check.saveData"), 1`);

  section("the page threw nothing");
  check("no page errors", b.pageErrors.length === 0, b.pageErrors.slice(0, 5).join(" | "));
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
