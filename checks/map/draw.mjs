// A trip's map drawn offline, cut from a real world build: the cut's label-font list against what
// MapLibre actually asks for while drawing names in scripts it doesn't draw from the font files.
//
//   node checks/map/draw.mjs --fonts <basemaps-assets>/fonts [--world <url of a world build>] [--port <port>] [--shots <folder>]
//
// For each place (Kyoto's center: kanji and kana; Seoul's: Hangul), on a server of its own whose
// map maker cuts from the world build (the newest daily one unless --world says): a trip with that
// region; its map made by the Worker; the fonts the cut lists put in the local bucket; the map
// opened as the host in Chrome for Testing with the service worker on, kept, then drawn again
// with the network off. It holds:
//   - every font range MapLibre itself asks for while drawing is on the cut's list, so nothing is
//     missing offline (src/map/glyphs.js leaves off the ranges MapLibre draws from the phone's own
//     font; were map.js to turn that off, MapLibre would ask for them and this fails);
//   - offline, the map draws with no font range failing to load and no page error.
// It reads someone else's world build over the network (by range, a few MB), so it isn't in the
// standing set; run it when the map's fonts or MapLibre change. Everyone in it is made up.

import fs from "node:fs";
import path from "node:path";
import { CheckError, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { openChrome } from "../lib/chrome.mjs";
import { styleFonts } from "../../tools/fonts-upload.mjs";
import { worldUrl } from "../../src/map/cut.js";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const fontsDir = flag("--fonts");
const port = Number(flag("--port") ?? 8812);
const shots = flag("--shots");
if (!fontsDir || !fs.existsSync(fontsDir)) { console.error("usage: node checks/map/draw.mjs --fonts <basemaps-assets>/fonts [--world <url>] [--port <port>] [--shots <folder>]"); process.exit(2); }
if (shots) fs.mkdirSync(shots, { recursive: true });
const world = flag("--world") ?? await worldUrl({});
const t = new Report("a real cut's map, drawn offline");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLACES = [
  { name: "kyoto", tz: "Asia/Tokyo", box: { west: 135.74, south: 34.98, east: 135.79, north: 35.03 } },
  { name: "seoul", tz: "Asia/Seoul", box: { west: 126.96, south: 37.55, east: 127.01, north: 37.59 } },
];

let server, chrome, code = 1;
try {
  server = await startServer({ name: "map-draw", port, maps: true, vars: { WORLD_URL: world } });
  await server.start();
  chrome = await openChrome();
  const host = new Person(server.origin, "Map Check");
  await host.signUp();
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  for (const place of PLACES) {
    t.part(`${place.name}, from ${world.split("/").pop()}`);
    const trip = (await host.post("/api/trips", { name: `A trip to ${place.name}`, default_tz: place.tz, starts_on: day(1), ends_on: day(4) })).json.trip;
    const T = `/api/trips/${trip.id}`;
    await host.call("PUT", `${T}/areas`, { areas: [{ id: "region", name: place.name, ...place.box }] });
    let tiles = null;
    for (let i = 0; i < 240; i++) { tiles = (await host.get(T)).json.tiles; if (tiles && (tiles.state === "ready" || tiles.state === "failed")) break; await sleep(500); }
    t.ok(`the Worker cuts its map from the world build (${tiles?.bytes} bytes, ${tiles?.glyphs?.length} font ranges listed)`, tiles?.state === "ready", tiles?.note ?? "");
    if (tiles?.state !== "ready") continue;
    for (const f of styleFonts()) for (const r of tiles.glyphs) { const p = path.join(fontsDir, f, `${r}.pbf`); if (fs.existsSync(p)) server.put("wegoplace-tiles", `fonts/${f}/${r}.pbf`, p); }

    const page = await chrome.page({ width: 390, height: 844, mobile: true, serviceWorker: true });
    await page.setCookie(server.origin, "wgp_session", host.jar.cookies.get("wgp_session"));
    const byMapLibre = [];
    const failedFonts = [];
    page.on((m) => {
      if (m.method === "Network.requestWillBeSent") {
        const u = new URL(m.params.request.url);
        const from = m.params.initiator?.stack?.callFrames?.[0]?.url ?? "";
        if (u.pathname.startsWith("/tiles/fonts/") && /maplibre/.test(from)) byMapLibre.push(decodeURIComponent(u.pathname).split("/").pop().replace(/\.pbf$/, ""));
      }
      if (m.method === "Runtime.consoleAPICalled" && /Unable to load glyph range/.test(m.params.args?.map((a) => a.value ?? "").join(" ") ?? "")) failedFonts.push(m.params.args[0].value);
    });
    await page.send("Page.navigate", { url: `${server.origin}/t/${trip.id}/#/map` });
    await page.until(`!!document.querySelector("canvas")`, "the map", 30000);
    await sleep(12000);   // drawn, its archive kept, its fonts kept
    const listed = new Set(tiles.glyphs);
    const notListed = [...new Set(byMapLibre)].filter((r) => !listed.has(r));
    t.ok(`every font range MapLibre asks for while drawing is on the cut's list (it asked for ${new Set(byMapLibre).size})`, notListed.length === 0, notListed.join(", "));
    if (shots) fs.writeFileSync(path.join(shots, `${place.name}-online.png`), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    await page.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    const failedBefore = failedFonts.length;
    await page.send("Page.reload", {});
    await sleep(1500);
    await page.until(`!!document.querySelector("canvas")`, "the map, offline", 30000);
    await sleep(8000);
    if (shots) fs.writeFileSync(path.join(shots, `${place.name}-offline.png`), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    t.ok("with the network off the map draws again, no font range failing to load and no page error",
      failedFonts.length === failedBefore && page.errors.length === 0, [...failedFonts.slice(failedBefore), ...page.errors].join(" | ").slice(0, 300));
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
