// A trip's map kept WITHOUT THE MAP EVER BEING OPENED, then drawn with no server at all: on a
// real cut of a real world build, with the real label fonts and the app's service worker on.
//
//   node scripts/map_keep_real.mjs --fonts <basemaps-assets>/fonts [--world <url of a world build>] [--port <port>] [--shots <folder>]
//
// map_keep_check.mjs (on the gate) plays the archive and the fonts in the network layer and has
// no service worker; it holds the rules. This one holds the thing itself, end to end:
//
//   A. A CUT. A trip with one region (Lisbon's center: Latin names with accents); the Worker
//      cuts its map; the fonts the cut lists are put in the local bucket. A person opens the
//      trip at its first screen and never opens the map. The app says its one line, the archive
//      and every listed range of every font the style names land in the phone's caches, and a
//      second open asks for none of it again.
//   B. AN UPLOADED MAP THAT LISTS NO FONTS. The same bytes, uploaded to a second trip as a
//      host would upload a .pmtiles file, the trip's region drawn on it as in A. Only the Latin
//      ranges exist for it to keep, and it keeps them (0-255 and 256-511 of each font).
//      ITS LIMIT, not held here: nobody has read which scripts an uploaded file's names use,
//      so a name in another script (zoomed far out from Lisbon, a country's name in Arabic)
//      is drawn from a range the phone has only if it was drawn once with signal; without
//      it MapLibre draws those letters in the phone's own font. A cut has no such limit: the
//      Worker lists the ranges its names use.
//   Then THE SERVER IS STOPPED (nothing answers: stronger than a browser's "offline" switch,
//   which doesn't reach the worker's own requests), each trip is opened again and only now
//   the map: it draws from the phone's copy, MapLibre's font requests are all answered by the
//   worker's cache, no range fails, and place names are on the map.
//
// It reads someone else's world build over the network (by range, a few MB), so it isn't on the
// gate; run it when the keep, the map's fonts or MapLibre change. Everyone in it is made up.

import fs from "node:fs";
import path from "node:path";
import { CheckError, startServer } from "../checks/lib/server.mjs";
import { Person, Report } from "../checks/lib/person.mjs";
import { openChrome } from "../checks/lib/chrome.mjs";
import { styleFonts } from "../tools/fonts-upload.mjs";
import { worldUrl } from "../src/map/cut.js";
import { TILE_CACHE, GLYPH_CACHE, VERSION_HEADER, KEEPING_WORDS, LATIN, archiveUrl } from "../public/js/map-keep.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const fontsDir = flag("--fonts");
const port = Number(flag("--port") ?? 8814);
const shots = flag("--shots");
if (!fontsDir || !fs.existsSync(fontsDir)) { console.error("usage: node scripts/map_keep_real.mjs --fonts <basemaps-assets>/fonts [--world <url>] [--port <port>] [--shots <folder>]"); process.exit(2); }
if (shots) fs.mkdirSync(shots, { recursive: true });
const world = flag("--world") ?? await worldUrl({});
const t = new Report("a trip's map kept without the map being opened, then drawn with no server");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOX = { west: -9.16, south: 38.70, east: -9.12, north: 38.73 };      // Lisbon's center
const FONTS = styleFonts();

// Every line the app's message bar shows, each time it comes onto the screen, kept across reloads.
const HEAR = `(() => {
  let showing = new Set();
  const note = () => {
    const n = document.getElementById("toast");
    const words = n && !n.hidden ? n.innerText.trim() : "";
    const now = new Set(words.split("\\n").map((s) => s.trim()).filter(Boolean));
    const fresh = [...now].filter((line) => !showing.has(line));
    showing = now;
    if (!fresh.length) return;
    sessionStorage.setItem("check.said", JSON.stringify([...JSON.parse(sessionStorage.getItem("check.said") || "[]"), ...fresh]));
  };
  new MutationObserver(note).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
})()`;

// What the phone holds of a trip's map: the archive's version and size, and the font files.
const keptOf = (tripId) => `(async () => {
  const a = await (await caches.open(${JSON.stringify(TILE_CACHE)})).match(${JSON.stringify(archiveUrl(tripId))});
  const g = await (await caches.open(${JSON.stringify(GLYPH_CACHE)})).keys();
  return JSON.stringify({
    archive: a ? { version: a.headers.get(${JSON.stringify(VERSION_HEADER)}), bytes: (await a.blob()).size } : null,
    glyphs: g.map((r) => decodeURIComponent(new URL(r.url).pathname)).filter((p) => p.startsWith("/tiles/fonts/")),
  });
})()`;

// The names MapLibre has put on the map: the text of every label it drew.
const NAMES = `(() => {
  const m = window.__wgpMap;
  if (!m || !m.isStyleLoaded()) return "[]";
  const labels = m.getStyle().layers.filter((l) => l.type === "symbol").map((l) => l.id);
  const drawn = m.queryRenderedFeatures({ layers: labels });
  return JSON.stringify([...new Set(drawn.map((f) => f.properties.name || f.properties["name:en"] || "").filter(Boolean))]);
})()`;

const shot = async (page, name) => {
  if (!shots) return;
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
};

/** One person's phone on one trip: its page, and what the page asked the network for. */
async function phone(chrome, origin, host, tripId) {
  const page = await chrome.page({ width: 390, height: 844, mobile: true, serviceWorker: true, before: HEAR });
  await page.setCookie(origin, "wgp_session", host.jar.cookies.get("wgp_session"));
  const seen = { asked: [], byMapLibre: [], answered: [], failed: [] };
  const urlOf = new Map();
  page.on((m) => {
    if (m.method === "Network.requestWillBeSent") {
      const u = new URL(m.params.request.url);
      urlOf.set(m.params.requestId, u);
      seen.asked.push(u.pathname + u.search);
      const from = m.params.initiator?.stack?.callFrames?.[0]?.url ?? "";
      if (u.pathname.startsWith("/tiles/fonts/") && /maplibre/.test(from)) seen.byMapLibre.push(decodeURIComponent(u.pathname));
    }
    if (m.method === "Network.responseReceived") {
      const u = urlOf.get(m.params.requestId);
      if (u && u.pathname.startsWith("/tiles/fonts/")) seen.answered.push({ path: decodeURIComponent(u.pathname), status: m.params.response.status, worker: !!m.params.response.fromServiceWorker });
    }
    if (m.method === "Runtime.consoleAPICalled" && /Unable to load glyph range/.test(m.params.args?.map((a) => a.value ?? "").join(" ") ?? "")) seen.failed.push(m.params.args[0].value);
  });
  return { page, seen, tripId };
}

/** Waits for the phone to hold the trip's map at `version` with `count` font files, or 90 s. */
async function untilKept(page, tripId, version, count) {
  let kept = null;
  for (let i = 0; i < 180; i++) {
    try { kept = JSON.parse(await page.eval(keptOf(tripId))); } catch { kept = null; }
    if (kept && kept.archive && kept.archive.version === version && kept.glyphs.length >= count) break;
    await sleep(500);
  }
  return kept;
}

let server, chrome, code = 1;
try {
  server = await startServer({ name: "map-keep-real", port, maps: true, vars: { WORLD_URL: world } });
  await server.start();
  chrome = await openChrome();
  const host = new Person(server.origin, "Map Keeper");
  await host.signUp();
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const newTrip = async (name) => (await host.post("/api/trips", { name, default_tz: "Europe/Lisbon", starts_on: day(1), ends_on: day(4) })).json.trip;
  const tilesOf = async (id) => (await host.get(`/api/trips/${id}`)).json.tiles;

  // ---------------------------------------------------------------- A. a cut
  t.part(`A. a cut of ${world.split("/").pop()}: the trip opened, the map never`);
  const cutTrip = await newTrip("A cut map (a made-up trip)");
  await host.call("PUT", `/api/trips/${cutTrip.id}/areas`, { areas: [{ id: "region", name: "The old town", ...BOX }] });
  let cut = null;
  for (let i = 0; i < 240; i++) { cut = await tilesOf(cutTrip.id); if (cut && (cut.state === "ready" || cut.state === "failed")) break; await sleep(500); }
  t.ok(`the Worker cuts the trip's map (${cut?.bytes} bytes, ${cut?.glyphs?.length} font ranges listed)`, cut?.state === "ready" && cut.glyphs.length > 0, cut?.note ?? "");
  if (cut?.state !== "ready") throw new CheckError("no cut to go on with: is the world build reachable?");
  // The fonts the server can give: every range either map will ask for, where the folder has it.
  const inBucket = new Set();
  for (const f of FONTS) for (const r of new Set([...cut.glyphs, ...LATIN])) {
    const p = path.join(fontsDir, f, `${r}.pbf`);
    if (fs.existsSync(p)) { server.put("wegoplace-tiles", `fonts/${f}/${r}.pbf`, p); inBucket.add(`/tiles/fonts/${f}/${r}.pbf`); }
  }
  const wantCut = FONTS.flatMap((f) => cut.glyphs.map((r) => `/tiles/fonts/${f}/${r}.pbf`)).filter((p) => inBucket.has(p));
  t.ok(`the style names ${FONTS.length} fonts and the fonts folder has the cut's ranges of each (${wantCut.length} files)`, wantCut.length === FONTS.length * cut.glyphs.length, `${wantCut.length} of ${FONTS.length * cut.glyphs.length}`);

  const a = await phone(chrome, server.origin, host, cutTrip.id);
  await a.page.open(`${server.origin}/t/${cutTrip.id}/`);
  await a.page.until(`!!document.querySelector("#view") && !!navigator.serviceWorker.controller`, "the trip's first screen, the worker in control", 60000);
  let kept = await untilKept(a.page, cutTrip.id, cut.version, wantCut.length);
  t.ok("the archive is on the phone at the trip's version, whole", kept?.archive?.version === cut.version && kept.archive.bytes === cut.bytes, JSON.stringify(kept?.archive));
  const lacking = wantCut.filter((p) => !kept?.glyphs.includes(p));
  t.ok(`every listed range of every font the style names is on the phone (${kept?.glyphs.length} files)`, lacking.length === 0, lacking.slice(0, 6).join(", "));
  const saidA = JSON.parse(await a.page.eval(`sessionStorage.getItem("check.said") || "[]"`));
  t.ok(`the app said so in one line, once: “${KEEPING_WORDS}”`, saidA.filter((s) => s === KEEPING_WORDS).length === 1, JSON.stringify(saidA));
  t.ok("the map was never opened: no map on the page, MapLibre never asked for",
    (await a.page.eval(`!window.__wgpMap && !document.querySelector("canvas.maplibregl-canvas") && !/map/.test(location.hash)`)) === true && !a.seen.asked.some((u) => /maplibre/.test(u)), a.seen.asked.filter((u) => /maplibre/.test(u)).join(", "));
  await shot(a.page, "A-trip-open-map-kept");
  // A second open with signal asks for none of it again.
  const before = a.seen.asked.length;
  await a.page.send("Page.reload", {});
  await a.page.until(`!!document.querySelector("#view") && document.readyState === "complete"`, "the trip again", 30000);
  await sleep(9000);
  const again = a.seen.asked.slice(before).filter((u) => u.startsWith(archiveUrl(cutTrip.id)) || u.startsWith("/tiles/fonts/"));
  t.ok("a second open asks the server for no part of the map again", again.length === 0, again.slice(0, 6).join(", "));

  // ---------------------------------------------------------------- B. an uploaded map
  t.part("B. the same bytes as an uploaded map, which lists no fonts");
  const bytes = Buffer.from(await (await fetch(`${server.origin}${archiveUrl(cutTrip.id)}?v=${encodeURIComponent(cut.version)}`, { headers: { Cookie: host.jar.header() } })).arrayBuffer());
  t.ok("the cut's bytes read back whole", bytes.length === cut.bytes, `${bytes.length} of ${cut.bytes}`);
  const upTrip = await newTrip("An uploaded map (a made-up trip)");
  const U = `/api/trips/${upTrip.id}`;
  // Its region first, and the cut that follows a region left to finish: the upload then takes
  // its place (were the upload made first, the cut landing after it would be the trip's map).
  await host.call("PUT", `${U}/areas`, { areas: [{ id: "region", name: "The old town", ...BOX }] });
  for (let i = 0; i < 240; i++) { const m = await tilesOf(upTrip.id); if (m && (m.state === "ready" || m.state === "failed")) break; await sleep(500); }
  const begun = (await host.post(`${U}/media/begin`, { name: "old-town.pmtiles", mime: "application/vnd.pmtiles", bytes: bytes.length, kind: "map" })).json;
  const part = (await host.call("PUT", `${U}/media/part?key=${encodeURIComponent(begun.key)}&id=${encodeURIComponent(begun.uploadId)}&n=1`, bytes, { headers: { "Content-Type": "application/octet-stream" } })).json;
  await host.post(`${U}/media/finish`, { key: begun.key, id: begun.uploadId, parts: [{ n: 1, etag: part.etag }] });
  const used = await host.post(`${U}/tiles/use`, { key: begun.key });
  let up = null;
  for (let i = 0; i < 60; i++) { up = await tilesOf(upTrip.id); if (up && (up.state === "ready" || up.state === "failed")) break; await sleep(500); }
  t.ok("the server takes the upload as the trip's map, and it lists no fonts", used.status === 200 && up?.state === "ready" && up.source !== cut.source && (up.glyphs || []).length === 0,
    `${used.status} ${used.text.slice(0, 160)} ${JSON.stringify({ state: up?.state, source: up?.source, glyphs: up?.glyphs?.length })}`);
  const wantUp = FONTS.flatMap((f) => LATIN.map((r) => `/tiles/fonts/${f}/${r}.pbf`)).filter((p) => inBucket.has(p));

  const b = await phone(chrome, server.origin, host, upTrip.id);     // a browser of its own: nothing of trip A's
  await b.page.open(`${server.origin}/t/${upTrip.id}/`);
  await b.page.until(`!!document.querySelector("#view") && !!navigator.serviceWorker.controller`, "the second trip's first screen", 60000);
  kept = await untilKept(b.page, upTrip.id, up.version, wantUp.length);
  t.ok("its archive is on the phone, whole, the map never opened", kept?.archive?.bytes === bytes.length && (await b.page.eval(`!window.__wgpMap`)) === true, JSON.stringify(kept?.archive));
  const lackingUp = wantUp.filter((p) => !kept?.glyphs.includes(p));
  t.ok(`the Latin ranges (${LATIN.join(", ")}) of each font the style names are on the phone, and only those (${kept?.glyphs.length} files)`,
    lackingUp.length === 0 && kept?.glyphs.length === wantUp.length, `lacking ${lackingUp.slice(0, 6).join(", ")}; kept ${kept?.glyphs.length}, wanted ${wantUp.length}`);
  await shot(b.page, "B-trip-open-map-kept");

  // ---------------------------------------------------------------- no server
  await server.stop();
  server = null;
  for (const [label, ph, only] of [["A", a, null], ["B", b, new Set(wantUp)]]) {
    t.part(`${label}. the server stopped; the trip opened again, and only now the map`);
    const { page, seen } = ph;
    await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    const errorsBefore = page.errors.length;
    await page.send("Page.reload", {});
    await sleep(1500);
    await page.until(`!!document.querySelector("#view")`, "the trip, from the phone", 30000);
    const asked0 = seen.byMapLibre.length, answered0 = seen.answered.length, failed0 = seen.failed.length;
    await page.eval(`(location.hash = "#/map", 1)`);
    await page.until(`!!document.querySelector("canvas.maplibregl-canvas") && !!window.__wgpMap`, "the map", 30000);
    let names = [];
    for (let i = 0; i < 40 && !names.length; i++) { await sleep(500); try { names = JSON.parse(await page.eval(NAMES)); } catch { /* not yet */ } }
    await sleep(4000);
    try { names = JSON.parse(await page.eval(NAMES)); } catch { /* keeps the last */ }
    await shot(page, `${label}-map-no-server`);
    const asked = [...new Set(seen.byMapLibre.slice(asked0))];
    const answers = seen.answered.slice(answered0);
    const unanswered = asked.filter((p) => !answers.some((r) => r.path === p && r.status === 200 && r.worker));
    t.ok(`MapLibre asked for ${asked.length} font files to draw the names, and the worker's cache answered every one`, asked.length > 0 && unanswered.length === 0, unanswered.slice(0, 6).join(", "));
    if (only) t.ok("each of those is a Latin range the phone kept", asked.every((p) => only.has(p)), asked.filter((p) => !only.has(p)).join(", "));
    t.ok("no font range failed to load", seen.failed.length === failed0, seen.failed.slice(failed0).join(" | ").slice(0, 300));
    t.ok(`place names are on the map (${names.length}: ${names.slice(0, 4).join(", ")}…)`, names.length >= 3, JSON.stringify(names));
    const errors = page.errors.slice(errorsBefore);
    t.ok("and the page threw nothing", errors.length === 0, errors.join(" | ").slice(0, 300));
  }
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await chrome?.close();
  await server?.stop();
}
process.exit(code);
