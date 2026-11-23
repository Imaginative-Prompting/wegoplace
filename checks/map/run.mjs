// A trip's offline map, cut from the world build (model §5 "Map"; docs/map-options.md; src/map/).
//
//   npm run check:map -- --world <a .pmtiles archive> --pmtiles <the official pmtiles binary>
//
// Never the network: the world build is stood in by an archive on this machine, served by range
// from a local server (checks/map/world.mjs), and the official tool reads the same address. Without
// both it can't run (exit 2). Where to get them: checks/map/README.md.
//
// 1. The cut, held against the official tool: for several boxes, every tile in our archive is the
//    same tile, byte for byte, as in `pmtiles extract`'s from the same world, and neither holds a
//    tile the other doesn't; `pmtiles verify` passes ours; the reader is held to `pmtiles tile`.
// 2. The stand-in rebuilt: the regions it was cut with (the GeoJSON beside it, or --regions) cut
//    again hold exactly its tiles. Without them, skipped, and the parts below use the made-up trip's
//    regions (seed/demo-trip.json, inside the stand-in).
// 3. The depth rule: with a small budget, the region costing most drops first, the file fits.
// 4. The label fonts' ranges, read out of a cut, on a planted tile and on the stand-in.
// 4b. A world server that ignores the range or answers another: the Worker's reader refuses it in
//    words before reading its body (never the planet whole).
// 5. Memory and time: the biggest cut the stand-in allows, measured.
// 6. On a check server: areas written, the map cut by the trip's map maker and served; a second
//    write cutting again (the old file to the drain), a rename cutting nothing; the world
//    unreachable; no region; the host's "cut again"; a trip left "cutting"; the day's limit; a
//    trip deleted; every read of the world saying who asks.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CheckError, ROOT, startServer } from "../lib/server.mjs";
import { Person, Report } from "../lib/person.mjs";
import { Archive, COMPRESSION, boxTileCount, boxTileIds, gzip, planCut, writeCut, writeHeader, tileIdToZxy, zxyToTileId } from "../../src/map/pmtiles.js";
import { drawnFromPhoneFont, glyphRanges, labelsIn } from "../../src/map/glyphs.js";
import { rangeReader } from "../../src/map/cut.js";
import { fileRange, httpRange, serveWorld } from "./world.mjs";

const run = promisify(execFile);
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const WORLD = flag("--world");
const PM = flag("--pmtiles");
const port = Number(flag("--port") ?? 8791);
const REGIONS_FLAG = flag("--regions");
const t = new Report("a trip's map, cut from the world");
if (!WORLD || !PM || !fs.existsSync(WORLD) || !fs.existsSync(PM)) {
  console.error("CAN'T RUN: --world <archive.pmtiles> and --pmtiles <the official tool> are needed (checks/map/README.md says where to get them).");
  process.exit(2);
}
/**
 * The regions a stand-in was cut with, as [{ id, name, west, south, east, north }]: from a list of
 * those, or from a GeoJSON (a Feature or FeatureCollection whose polygons are the boxes, as
 * `pmtiles extract --region` takes one), each polygon's bounds a region.
 */
function readRegions(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(doc)) return doc;
  const features = doc.type === "FeatureCollection" ? doc.features : [doc];
  const polygons = features.flatMap((f) => (f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates]));
  return polygons.map((rings, i) => {
    const pts = rings[0];
    const lons = pts.map((q) => q[0]), lats = pts.map((q) => q[1]);
    return { id: `region-${i + 1}`, name: `Region ${i + 1}`, west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
  });
}
// The stand-in's regions: --regions, or the GeoJSON beside it that it was cut with (<name>-region.geojson).
const REGIONS_FILE = REGIONS_FLAG ?? [path.join(path.dirname(WORLD), `${path.basename(WORLD, ".pmtiles")}-region.geojson`)].find((f) => fs.existsSync(f)) ?? null;
const STANDIN_REGIONS = REGIONS_FILE ? readRegions(REGIONS_FILE) : null;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-map-"));
let world;
let server;
let failing;
let planning;
let code = 1;

/** Every tile of an archive file: Map id -> bytes. */
async function tilesOf(file) {
  const a = await Archive.open(fileRange(file));
  const out = new Map();
  for (const e of await a.allTiles()) out.set(e.id, Buffer.from(await a.fetch(a.header.dataOffset + e.offset, e.length)));
  return out;
}
/** Two archives' tiles compared: [ours only, theirs only, differing]. */
function compare(ours, theirs) {
  const onlyOurs = [...ours.keys()].filter((id) => !theirs.has(id));
  const onlyTheirs = [...theirs.keys()].filter((id) => !ours.has(id));
  const differ = [...ours.keys()].filter((id) => theirs.has(id) && Buffer.compare(ours.get(id), theirs.get(id)) !== 0);
  return [onlyOurs.length, onlyTheirs.length, differ.length];
}
async function cutTo(file, archive, regions, opts) {
  const plan = await planCut(archive, regions, opts);
  const fd = fs.openSync(file, "w");
  try { await writeCut(archive, plan, { write: async (b) => { fs.writeSync(fd, b); } }); } finally { fs.closeSync(fd); }
  return plan;
}

try {
  world = await serveWorld(WORLD);
  const src = await Archive.open(httpRange(world.url));
  const h = src.header;
  const box = { west: h.minLon, south: h.minLat, east: h.maxLon, north: h.maxLat };
  const span = (f) => ({ lon: box.west + (box.east - box.west) * f, lat: box.south + (box.north - box.south) * f });

  t.part("1. The cut, held against the official tool");
  const ids = [[0, 0, 0], [1, 1, 0], [5, 9, 16], [14, 4685, 8749], [15, 9000, 17000], [26, 3, 7]];
  t.ok("tile ids go to z/x/y and back", ids.every(([z, x, y]) => tileIdToZxy(zxyToTileId(z, x, y)).join() === [z, x, y].join()));
  const sample = (await src.allTiles()).filter((_, i, all) => i % Math.ceil(all.length / 12) === 0).slice(0, 12);
  const readerSame = [];
  for (const e of sample) {
    const [z, x, y] = tileIdToZxy(e.id);
    const cli = (await run(PM, ["tile", WORLD, String(z), String(x), String(y)], { encoding: "buffer", maxBuffer: 1 << 26 })).stdout;
    readerSame.push(Buffer.compare(Buffer.from(await src.tile(z, x, y)), cli) === 0);
  }
  t.ok(`  (the reader reads the same bytes as \`pmtiles tile\` for ${sample.length} tiles across the stand-in)`, readerSame.every(Boolean), readerSame);
  const boxes = [
    { name: "a city at 14", depth: 14, ...{ west: span(0.05).lon, south: span(0.6).lat, east: span(0.08).lon, north: span(0.65).lat } },
    { name: "a wider area at 12", depth: 12, ...{ west: span(0.6).lon, south: span(0.2).lat, east: span(0.85).lon, north: span(0.5).lat } },
    { name: "a small box at 13", depth: 13, ...{ west: span(0.3).lon, south: span(0.3).lat, east: span(0.31).lon, north: span(0.31).lat } },
    { name: "a box half outside the world file, at 10", depth: 10, ...{ west: box.west - 1, south: box.south - 1, east: span(0.2).lon, north: span(0.2).lat } },
  ];
  for (const b of boxes) {
    const ours = path.join(work, "ours.pmtiles");
    const theirs = path.join(work, "theirs.pmtiles");
    await cutTo(ours, src, [{ id: "b", ...b }], { budget: 1e12, maxDepth: b.depth });
    await run(PM, ["extract", world.url, theirs, `--bbox=${b.west},${b.south},${b.east},${b.north}`, `--maxzoom=${b.depth}`, "-q"]);
    const [o, th] = [await tilesOf(ours), await tilesOf(theirs)];
    const verify = await run(PM, ["verify", ours]).then(() => true, (e) => String(e.stderr ?? e).slice(0, 200));
    t.same(`${b.name}: ${th.size} tiles in the official tool's archive; ours holds exactly those, byte for byte, and passes \`pmtiles verify\``,
      [o.size, compare(o, th), verify], [th.size, [0, 0, 0], true]);
  }

  t.part("2. The stand-in, rebuilt from the regions it was cut with");
  let regions;
  if (STANDIN_REGIONS) {
    regions = STANDIN_REGIONS;
    const rebuilt = path.join(work, "rebuilt.pmtiles");
    const p = await cutTo(rebuilt, src, regions, { budget: 1e12, maxDepth: h.maxZoom });
    const [mine, whole] = [await tilesOf(rebuilt), await tilesOf(WORLD)];
    t.same(`its ${regions.length} regions (${path.basename(REGIONS_FILE)}), cut at the stand-in's depth (${h.maxZoom}), hold the stand-in's ${whole.size} tiles exactly, byte for byte`,
      [mine.size, compare(mine, whole)], [whole.size, [0, 0, 0]]);
    t.ok(`  (and its size: ${(fs.statSync(rebuilt).size / 1e6).toFixed(1)} MB against the stand-in's ${(fs.statSync(WORLD).size / 1e6).toFixed(1)} MB)`, Math.abs(fs.statSync(rebuilt).size - fs.statSync(WORLD).size) < 64 * 1024, p.regions);
  } else {
    // No file of the regions the stand-in was cut with: the rest runs on the made-up trip's.
    regions = JSON.parse(fs.readFileSync(path.join(ROOT, "seed/demo-trip.json"), "utf8")).areas.filter((a) => !a.parent && a.west !== undefined);
    console.log(`    skipped: no regions file beside the stand-in (${path.basename(WORLD, ".pmtiles")}-region.geojson) and no --regions; the parts below use the made-up trip's ${regions.length} regions`);
  }

  t.part("3. Each region to its own depth, the whole within the budget");
  const small = await planCut(src, regions, { budget: 6e6, maxDepth: h.maxZoom, minDepth: 8 });
  for (const r of small.regions) console.log(`    ${r.id}: depth ${r.depth ?? "left out"}, ${(r.bytes / 1e6).toFixed(2)} MB, ${r.tiles} tiles`);
  t.ok(`a 6 MB budget: the file fits (${(small.bytes / 1e6).toFixed(2)} MB), and the regions that cost most went shallower than the cheap ones`,
    small.bytes <= 6e6 && small.regions.some((r) => r.depth < h.maxZoom) && small.leftOut.length === 0, small.regions);
  const tiny = await planCut(src, regions, { budget: 50e3, maxDepth: h.maxZoom, minDepth: 10 });
  t.ok(`a budget no region fits at its least depth: they are left out by name, and the file is what's left (${tiny.leftOut.join(", ")})`,
    tiny.leftOut.length > 0 && tiny.bytes <= 50e3, tiny.regions);

  t.part("4. The label fonts a map needs offline");
  // A vector tile written by hand: one layer, two features, a name in Greek and one in Chinese
  // under a key the app doesn't draw.
  const enc = new TextEncoder();
  const vint = (n) => { const o = []; while (n >= 128) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
  const lenField = (f, bytes) => [...vint(f * 8 + 2), ...vint(bytes.length), ...bytes];
  const value = (s) => lenField(1, enc.encode(s));
  const feature = (tags) => [...lenField(2, tags)];
  const layer = [...lenField(1, enc.encode("places")), ...lenField(3, enc.encode("name")), ...lenField(3, enc.encode("name:zh")),
    ...lenField(4, value("Ωmega")), ...lenField(4, value("中")), ...lenField(2, feature([0, 0, 1, 1]))];
  const planted = Uint8Array.from(lenField(3, layer));
  t.same("  (a planted tile: the name it draws is read, the Chinese name it doesn't draw isn't)", labelsIn(planted), ["Ωmega"]);
  const g = glyphRanges();
  await g.read(planted);
  t.same("  (and its ranges: Latin and Greek, not the Chinese one)", await g.done(), ["0-255", "768-1023"]);
  // A name with a character above U+FFFF that MapLibre would fetch (a mathematical letter): no font file
  // holds its range, so the list leaves it off and counts it.
  const beyondLayer = [...lenField(1, enc.encode("places")), ...lenField(3, enc.encode("name")), ...lenField(4, value("Ωmega 𝐀")), ...lenField(2, feature([0, 0]))];
  const g2 = glyphRanges();
  await g2.read(Uint8Array.from(lenField(3, beyondLayer)));
  t.same("  (a name with a character above U+FFFF and not drawn by the phone: its range left off the list, and counted)", [await g2.done(), g2.beyond()], [["0-255", "768-1023"], 1]);
  // MapLibre draws CJK, kana and Hangul from the phone's own font and never fetches their ranges
  // (its GlyphManager asks the function src/map/glyphs.js copies before downloading one).
  const vendored = fs.readFileSync(path.join(ROOT, "public/vendor/maplibre/maplibre-gl-shared.mjs"), "utf8");
  const at = vendored.indexOf("function Lc(e){");
  const theirs = at < 0 ? "" : vendored.slice(at + "function Lc(e){".length, vendored.indexOf("String.fromCodePoint(e))}", at) + "String.fromCodePoint(e))".length);
  const ours = drawnFromPhoneFont.toString().replace(/^[^{]*\{/, "").replace(/\}$/, "").trim();
  t.ok("the rule for what MapLibre draws from the phone's font is the vendored MapLibre's own, character for character (a new MapLibre changing it fails here)", theirs.length > 100 && ours === theirs, `${ours.slice(0, 60)} | ${theirs.slice(0, 60)}`);
  const cjkLayer = [...lenField(1, enc.encode("places")), ...lenField(3, enc.encode("name")), ...lenField(4, value("Kyoto 京都 かな 한")), ...lenField(2, feature([0, 0]))];
  const g3 = glyphRanges();
  await g3.read(Uint8Array.from(lenField(3, cjkLayer)));
  t.same("  (a name in Latin, kanji, kana and Hangul: only the Latin range is listed; the four the phone draws are counted)", [await g3.done(), g3.local()], [["0-255"], 4]);
  const all = glyphRanges();
  for (const bytes of (await tilesOf(WORLD)).values()) await all.read(bytes);
  const standInRanges = await all.done();
  t.ok(`the stand-in's labels need ${standInRanges.length} ranges of 256 characters (${standInRanges.slice(0, 6).join(", ")}${standInRanges.length > 6 ? ", …" : ""}), the first the basic Latin`, standInRanges[0] === "0-255", standInRanges);

  t.part("4b. A world server that misbehaves");
  // The Worker's own reader (src/map/cut.js), against the stand-in's two bad addresses: a 200 with
  // the whole file (no ranges) and a range a byte off. Each is refused in words before its body is
  // read; the good address reads the header as before.
  const tryRead = async (url) => {
    const { fetchRange } = rangeReader(url);
    try { const b = await fetchRange(0, 127); return { ok: true, bytes: b.length }; } catch (e) { return { ok: false, why: String(e.message) }; }
  };
  const goodAnswer = await tryRead(world.url);
  const wholeAnswer = await tryRead(world.url.replace("/world.pmtiles", "/whole/world.pmtiles"));
  const shiftedAnswer = await tryRead(world.url.replace("/world.pmtiles", "/shifted/world.pmtiles"));
  t.same("a server that ignores the range (the whole file) and one that answers another range are refused, saying which; a good one reads",
    [goodAnswer, wholeAnswer.ok, /doesn't answer by range/.test(wholeAnswer.why ?? ""), shiftedAnswer.ok, /another range than the one asked/.test(shiftedAnswer.why ?? "")],
    [{ ok: true, bytes: 127 }, false, true, false, true]);
  const tinyFile = path.join(work, "tiny.pmtiles");
  fs.writeFileSync(tinyFile, Buffer.alloc(100, 7));
  const smallWorld = await serveWorld(tinyFile);
  const smallWhole = await tryRead(smallWorld.url.replace("/world.pmtiles", "/whole/world.pmtiles"));
  await smallWorld.stop();
  t.same("  (a whole file no bigger than what was asked is taken as it is)", smallWhole, { ok: true, bytes: 100 });

  t.part("5. Memory and time, the biggest cut the stand-in allows");
  const before = world.served.requests;
  let biggestRead = 0;
  const reading = httpRange(world.url);
  const big = await Archive.open(async (o, n) => { const b = await reading(o, n); biggestRead = Math.max(biggestRead, b.length); return b; });
  let peak = process.memoryUsage().rss;
  const base = peak;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  const cpu0 = process.cpuUsage();
  const wall0 = Date.now();
  const plan = await planCut(big, regions, { budget: 48 * 1024 * 1024, maxDepth: 15 });
  const glyphs = glyphRanges();
  let written = 0;
  let biggestWrite = 0;
  await writeCut(big, plan, { write: async (b) => { written += b.length; biggestWrite = Math.max(biggestWrite, b.length); } }, { onTile: glyphs.read });
  await glyphs.done();
  clearInterval(sampler);
  const cpu = process.cpuUsage(cpu0);
  const report = { bytes: written, tiles: plan.tiles.length, requests: world.served.requests - before, wall_ms: Date.now() - wall0,
    cpu_ms: Math.round((cpu.user + cpu.system) / 1000), peak_rss_growth_mb: +((peak - base) / 1e6).toFixed(1),
    biggest_read_mb: +(biggestRead / 1e6).toFixed(2), biggest_write_mb: +(biggestWrite / 1e6).toFixed(2) };
  console.log(`    ${JSON.stringify(report)}`);
  // Held whole, it would be one write of its size; read whole, one read. Neither: no read is past
  // the run size (8 MB, the most writeCut asks for at once, with its gap), no write past a tile run.
  t.ok(`all four regions (${(written / 1e6).toFixed(1)} MB): never held whole (its biggest read ${report.biggest_read_mb} MB, its biggest write ${report.biggest_write_mb} MB; memory grew ${report.peak_rss_growth_mb} MB), ${report.requests} reads of the world, ${report.cpu_ms} ms of processor time`,
    biggestRead <= 8.25 * 1024 * 1024 && biggestWrite <= 8.25 * 1024 * 1024 && written > biggestRead && report.requests < 120, report);

  t.part("5a. A region across the 180° line");
  // areas.js takes a box with west > east (Fiji's Taveuni sits on the line); the cut measured it as
  // nothing (x0 > x1) and the trip was told the world had no tiles for it.
  {
    const fiji = { id: "taveuni", west: 179.6, south: -17.0, east: -179.8, north: -16.6 };
    const depth = 12, n = 2 ** depth;
    const ids = boxTileIds(fiji, depth);
    const xs = ids.map(tileIdToZxy).filter(([z]) => z === depth).map(([, x]) => x);
    t.same("a box across the line holds tiles from both sides of it at every depth, each once, and the count says the same",
      [xs.some((x) => x >= n - 8) && xs.some((x) => x <= 8), xs.every((x) => x >= n - 8 || x <= 8), new Set(ids).size === ids.length, boxTileCount(fiji, depth) === ids.length], [true, true, true, true]);
    // A made-up world that has every tile: the plan keeps the region, and its bounds say the whole width.
    const everything = { header: { maxZoom: 14 }, entriesFor: async (want) => new Map(want.map((id) => [id, { offset: id * 16, length: 16 }])) };
    const plan = await planCut(everything, [fiji], { budget: 64 * 1024 * 1024, maxDepth: 12 });
    const planXs = plan.tiles.map((x) => tileIdToZxy(x.id)).filter(([z]) => z === 12).map(([, x]) => x);
    t.same("cut, it is one region with its tiles from both sides, nothing left out, and the archive's bounds say the whole width",
      [plan.leftOut, plan.regions.length, planXs.some((x) => x >= n - 8) && planXs.some((x) => x <= 8), plan.bounds?.west, plan.bounds?.east], [[], 1, true, -180, 180]);
  }

  t.part("5b. A big cut is written (a region near its tile cap)");
  // Past ~125,000 tiles, Math.min(...zooms) ran out of stack at the write. A made-up archive whose
  // tiles all share one content: 140,000 tiles over zooms 12 to 14.
  {
    const tiles = [];
    for (const [z, n] of [[12, 4000], [13, 36000], [14, 100000]]) for (let i = 0; i < n; i++) tiles.push({ id: zxyToTileId(z, i % 2 ** z, Math.floor(i / 2 ** z)), offset: 0, length: 16 });
    tiles.sort((x, y) => x.id - y.id);
    const madeUp = {
      header: { internalCompression: COMPRESSION.none, tileCompression: COMPRESSION.none, tileType: 1, dataOffset: 0, minLon: -10, minLat: 35, maxLon: 5, maxLat: 44 },
      metadata: async () => new TextEncoder().encode("{}"),
      fetch: async (_offset, length) => new Uint8Array(length),
    };
    let wrote = 0, failed = null, out = null;
    try { out = await writeCut(madeUp, { tiles, bounds: { west: -10, south: 35, east: 5, north: 44 } }, { write: async (b) => { wrote += b.length; } }); } catch (e) { failed = e.message; }
    t.same(`${tiles.length.toLocaleString("en-US")} tiles over zooms 12 to 14 are written, the header saying 12 to 14 and every tile addressed`,
      [failed, out?.header?.minZoom, out?.header?.maxZoom, out?.header?.addressedTiles, out?.bytes === wrote], [null, 12, 14, 140000, true]);
  }

  t.part("6. On a check server: the trip's map maker");
  server = await startServer({ name: "map", port, maps: true, vars: { WORLD_URL: world.url, MAP_DELAY_MS: "300" } });
  await server.start();
  const person = async (name) => { const q = new Person(server.origin, name); if ((await q.signUp()).status !== 200) throw new CheckError(`couldn't make ${name}`); return q; };
  const host = await person("Hana Map");
  const guest = await person("Gil Map");
  const T = (await host.post("/api/trips", { name: "Map check", default_tz: "UTC" })).json.trip.id;
  const link = await host.post(`/api/trips/${T}/links`, { uses: 1 });
  await guest.post(`/api/join/${link.json.link.code}`);
  const tilesNow = async (who = host, trip = T) => (await who.get(`/api/trips/${trip}`)).json?.tiles ?? null;
  const until = async (holds, ms = 60000, trip = T) => { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await tilesNow(host, trip); if (holds(last)) return last; await new Promise((r) => setTimeout(r, 250)); } return last; };
  const first0 = regions[0];
  const region = { id: "city", name: "The city", west: first0.west, south: first0.south, east: first0.east, north: first0.north };
  t.same("a trip with no area has no map", await tilesNow(), null);
  const wrote = Date.now();
  world.served.agents.clear();
  await host.call("PUT", `/api/trips/${T}/areas`, { areas: [region, { id: "old-town", name: "Old town", parent: "city" }] });
  const first = await until((x) => x?.state === "ready");
  const agents = [...world.served.agents];
  const took = Date.now() - wrote;
  t.same(`its areas written, the map maker cuts its map: ready in ${(took / 1000).toFixed(1)} s, with its size, version, the label ranges it needs, made by a cut`,
    [first?.state, first?.source, Number.isInteger(first?.bytes) && first.bytes > 0, typeof first?.version, first?.glyphs?.[0], first?.note], ["ready", "cut", true, "string", "0-255", ""]);
  const head = await host.get(`/api/trips/${T}/tiles`, { headers: { Range: "bytes=0-126" } });
  const full = await fetch(`${server.origin}/api/trips/${T}/tiles`, { headers: { Cookie: host.jar.header(), "CF-Connecting-IP": host.address } });
  const served = Buffer.from(await full.arrayBuffer());
  t.same("the trip's tiles address serves it, by range (the header) and whole (its size the snapshot's)",
    [head.status, full.status, served.length], [206, 200, first?.bytes]);
  const servedFile = path.join(work, "served.pmtiles");
  fs.writeFileSync(servedFile, served);
  const expected = path.join(work, "expected.pmtiles");
  await cutTo(expected, src, [region], { budget: 48 * 1024 * 1024, maxDepth: 15 });
  t.same("  (and holds exactly the tiles the module cuts in Node from the same world, byte for byte)", compare(await tilesOf(servedFile), await tilesOf(expected)), [0, 0, 0]);
  t.same("  (someone on the trip reads the same map)", (await tilesNow(guest))?.version, first?.version);
  t.ok(`  (every read of the world says who asks: ${agents.join(" | ")})`, agents.length > 0 && agents.every((a) => /^WeGoPlace \(\+https?:\/\/.+\)$/.test(a)), agents);

  await host.call("PUT", `/api/trips/${T}/areas`, { areas: [{ id: "old-town", name: "The old town" }] });
  await new Promise((r) => setTimeout(r, 2500));
  t.same("an areas write that changes no region's bounds (a rename) makes no new map", (await tilesNow())?.version, first?.version);
  const shrunk = { ...region, east: region.west + (region.east - region.west) / 2 };
  await host.call("PUT", `/api/trips/${T}/areas`, { areas: [shrunk] });
  const second = await until((x) => x?.state === "ready" && x.version !== first.version);
  const oldKey = `trips/${T}/${first.version}.pmtiles`;
  t.same("a region's bounds changed: a new map, a new version, and the old file queued for the drain (its bucket the tiles')",
    [second?.version !== first?.version, server.sql(`SELECT bucket FROM files_to_delete WHERE r2_key = '${oldKey}'`)[0]?.bucket], [true, "tiles"]);
  const notHost = await guest.post(`/api/trips/${T}/tiles/cut`);
  const asked = await host.post(`/api/trips/${T}/tiles/cut`);
  const third = await until((x) => x?.state === "ready" && x.version !== second.version);
  t.same("the host asks for it again: a new map; someone else can't", [notHost.status, asked.status, third?.version !== second?.version], [403, 200, true]);

  // A map planned for areas as they'd be (POST …/tiles/plan): the cut's own planner, run on the
  // world the map maker reads, written nowhere; any member may ask.
  {
    const other = regions.find((r) => r.id !== first0.id) ?? regions[0];
    const added = { name: "The coast", west: other.west, south: other.south, east: other.east, north: other.north };
    const rev0 = server.sql(`SELECT rev FROM trips WHERE id = '${T}'`)[0].rev;
    // The city's box is the shrunk one by now (the bounds change above).
    const city = { west: shrunk.west, south: shrunk.south, east: shrunk.east, north: shrunk.north };
    const plan = await guest.post(`/api/trips/${T}/tiles/plan`, { areas: [{ id: "city", name: "The city", ...city }, added] });
    const opts = { budget: 48 * 1024 * 1024, maxDepth: 15, minDepth: 10 };
    const nowNode = await planCut(src, [{ id: "city", ...city }], opts);
    const wouldNode = await planCut(src, [{ id: "city", ...city }, { id: "new:1", ...added }], opts);
    t.same("a member plans the map with a town added: each area's depth now and as it would be, the planner's own in Node from the same world; nothing written",
      [plan.status, plan.json?.regions?.map((r) => [r.id, r.name, r.now, r.would]), plan.json?.bytes?.would, server.sql(`SELECT rev FROM trips WHERE id = '${T}'`)[0].rev],
      [200, [["city", "The city", nowNode.regions[0].depth, wouldNode.regions[0].depth], [null, "The coast", null, wouldNode.regions[1].depth]], wouldNode.bytes, rev0]);
    const bad = await guest.post(`/api/trips/${T}/tiles/plan`, { areas: [{ name: "Nowhere", west: 10, south: 5, east: 11, north: 4 }] });
    t.same("a box with its south above its north is refused in words", [bad.status, bad.json?.error], [400, "bad box"]);
  }

  // A cut that died where nothing could record it: the row left "cutting", planted.
  const nowS = Math.floor(Date.now() / 1000);
  server.sql(`UPDATE trips SET tiles_state = 'cutting', tiles_at = ${nowS - 3600} WHERE id = '${T}'`);
  const stale = await tilesNow();
  server.sql(`UPDATE trips SET tiles_state = 'cutting', tiles_at = ${nowS - 30} WHERE id = '${T}'`);
  const fresh = await tilesNow();
  server.sql(`UPDATE trips SET tiles_state = 'cutting', tiles_at = ${nowS - 3600} WHERE id = '${T}'`);
  await host.call("PUT", `/api/trips/${T}/areas`, { areas: [region] });
  const again = await until((x) => x?.state === "ready" && x.version !== third.version);
  t.same("a trip left \"cutting\" an hour: it reads as failed, saying the last map stays and what makes a new one; one cutting for 30 s is still cutting; the next areas write makes a map",
    [stale?.state, /stopped before it finished/.test(stale?.note ?? "") && /last map stays in use/.test(stale?.note ?? ""), stale?.version, fresh?.state, again?.state, again?.version !== third?.version],
    ["failed", true, third?.version, "cutting", "ready", true]);

  const U = (await host.post("/api/trips", { name: "No regions", default_tz: "UTC" })).json.trip.id;
  await host.call("PUT", `/api/trips/${U}/areas`, { areas: [{ id: "somewhere", name: "Somewhere" }] });
  const none = await until((x) => x?.state === "none", 20000, U);
  t.same("a trip whose areas have no bounds: no map, and the note says why", [none?.state, /no area with bounds/.test(none?.note ?? "")], ["none", true]);

  // The day's limit: a small region cut again and again.
  const D = (await host.post("/api/trips", { name: "Many cuts", default_tz: "UTC" })).json.trip.id;
  await host.call("PUT", `/api/trips/${D}/areas`, { areas: [{ id: "spot", name: "A spot", west: region.west, south: region.south, east: region.west + 0.02, north: region.south + 0.02 }] });
  let last = await until((x) => x?.state === "ready", 60000, D);
  let cuts = 1;
  for (let i = 0; i < 12; i++) {
    await host.post(`/api/trips/${D}/tiles/cut`);
    const next = await until((x) => (x?.state === "ready" && x.version !== last.version) || /times today/.test(x?.note ?? ""), 30000, D);
    if (/times today/.test(next?.note ?? "")) { last = next; break; }
    cuts += 1;
    last = next;
  }
  t.same("at most 12 cuts a trip a day: the 13th waits for tomorrow, and the note says so (the last map stays)", [cuts, /12 times today/.test(last?.note ?? ""), last?.state], [12, true, "ready"]);

  // The biggest cut the stand-in allows, in the Worker's own runtime: the local workerd process's
  // memory sampled while its map maker cuts all four regions, the world's reads counted.
  const { execFileSync } = await import("node:child_process");
  // The workerd process(es) in the server's own process group (the harness's record of it).
  const pgid = JSON.parse(fs.readFileSync(path.join(server.work, "server.pid"), "utf8")).pgid;
  const workerd = execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" }).trim().split("\n")
    .filter((pid) => /workerd/.test(execFileSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8" })));
  if (!workerd.length) throw new CheckError("no workerd process in the server's group to measure");
  const rss = () => workerd.reduce((n, pid) => n + Number(execFileSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" }).trim() || 0) * 1024, 0);
  const B = (await host.post("/api/trips", { name: "Whole map", default_tz: "UTC" })).json.trip.id;
  const rssBefore = rss();
  let rssPeak = rssBefore;
  const sampling = setInterval(() => { try { rssPeak = Math.max(rssPeak, rss()); } catch { /* gone */ } }, 50);
  const reads0 = world.served.requests;
  const t0 = Date.now();
  await host.call("PUT", `/api/trips/${B}/areas`, { areas: regions.map((r) => ({ id: r.id, name: r.name ?? r.id, west: r.west, south: r.south, east: r.east, north: r.north })) });
  const bigMap = await until((x) => x?.state === "ready", 120000, B);
  clearInterval(sampling);
  const measured = { bytes: bigMap?.bytes, wall_s: +((Date.now() - t0) / 1000).toFixed(1), world_reads: world.served.requests - reads0, workerd_rss_growth_mb: +((rssPeak - rssBefore) / 1e6).toFixed(1) };
  console.log(`    (in the Worker: ${JSON.stringify(measured)}; workerd process ${workerd.join(", ")})`);
  t.ok(`all four regions cut by the map maker in the Worker's runtime: ${(measured.bytes / 1e6).toFixed(1)} MB in ${measured.wall_s} s (from the write, the 0.3 s wait included), ${measured.world_reads} reads of the world, its process grew ${measured.workerd_rss_growth_mb} MB at most`,
    bigMap?.state === "ready" && measured.workerd_rss_growth_mb < 100, measured);

  const gone = await host.call("DELETE", `/api/trips/${T}`, { confirm: "Map check" });
  t.same("a trip deleted: its map goes to the drain with it", [gone.status, server.sql(`SELECT COUNT(*) AS n FROM files_to_delete WHERE bucket = 'tiles' AND r2_key = 'trips/${T}/${again?.version}.pmtiles'`)[0].n], [200, 1]);

  // A small budget: adding a town lowers the city a level (lowered), or leaves the new one out.
  {
    const one = await planCut(src, [{ id: "city", ...region }], { budget: 48 * 1024 * 1024, maxDepth: 15, minDepth: 10 });
    const small = Math.ceil(one.bytes * 1.05);
    // Its map maker waits 5 s before a cut, so what the trip says in those seconds can be read.
    planning = await startServer({ name: "map-plan", port: port + 6, maps: true, vars: { WORLD_URL: world.url, MAP_DELAY_MS: "5000", MAP_BUDGET_BYTES: String(small) } });
    await planning.start();
    const ph = new Person(planning.origin, "Pia Map");
    await ph.signUp();
    const P = (await ph.post("/api/trips", { name: "Small budget", default_tz: "UTC" })).json.trip.id;
    const tilesAt = async () => (await ph.get(`/api/trips/${P}`)).json?.tiles ?? null;
    await ph.call("PUT", `/api/trips/${P}/areas`, { areas: [region] });
    const atOnce = await tilesAt();
    let made = atOnce;
    for (let i = 0; i < 120 && made?.state !== "ready"; i++) { await new Promise((r) => setTimeout(r, 250)); made = await tilesAt(); }
    t.same("an areas write that will make a map says \"cutting\" at once, before the map maker's wait is over; then \"ready\"", [atOnce?.state, made?.state], ["cutting", "ready"]);
    await ph.call("PUT", `/api/trips/${P}/areas`, { areas: [{ ...region, name: "The city, renamed" }] });
    t.same("  (a rename, which makes no map, says nothing of the kind)", (await tilesAt())?.state, "ready");
    const other = regions.find((r) => r.id !== first0.id) ?? regions[0];
    const added = { name: "The coast", west: other.west, south: other.south, east: other.east, north: other.north };
    const plan = await ph.post(`/api/trips/${P}/tiles/plan`, { areas: [{ id: "city", name: "The city", west: region.west, south: region.south, east: region.east, north: region.north }, added] });
    const opts = { budget: small, maxDepth: 15, minDepth: 10 };
    const nowNode = await planCut(src, [{ id: "city", ...region }], opts);
    const wouldNode = await planCut(src, [{ id: "city", ...region }, { id: "new:1", ...added }], opts);
    const expectLowered = wouldNode.regions[0].depth !== null && wouldNode.regions[0].depth < nowNode.regions[0].depth ? ["The city"] : [];
    const expectLeftOut = wouldNode.leftOut.map((id) => (id === "city" ? "The city" : "The coast"));
    t.same(`on a budget that holds the city alone (${(small / 1e6).toFixed(1)} MB), adding a town: what is lowered and what is left out, as the planner says`,
      [plan.status, plan.json?.lowered, plan.json?.left_out, plan.json?.regions?.map((r) => [r.now, r.would])],
      [200, expectLowered, expectLeftOut, [[nowNode.regions[0].depth, wouldNode.regions[0].depth], [null, wouldNode.regions[1].depth]]]);
    t.ok("  (and something is lowered or left out there, so the sentence has something to say)", expectLowered.length + expectLeftOut.length > 0, { expectLowered, expectLeftOut });
    const up = await ph.post(`/api/trips/${P}/tiles/plan`, { areas: [added] });
    t.ok("  (a plan for areas that drop one the trip has says it would go)", up.json?.regions?.some((r) => r.id && r.removed && r.would === null), up.json?.regions);
  }

  // The world unreachable: a server of its own whose world is an address nothing answers.
  failing = await startServer({ name: "map-failing", port: port + 4, maps: true, vars: { WORLD_URL: "http://127.0.0.1:9/world.pmtiles", MAP_DELAY_MS: "300", STORAGE_LIMIT_BYTES: "100000" } });
  await failing.start();
  const fh = new Person(failing.origin, "Fay Map");
  await fh.signUp();
  const F = (await fh.post("/api/trips", { name: "No world", default_tz: "UTC" })).json.trip.id;
  const areasAnswer = await fh.call("PUT", `/api/trips/${F}/areas`, { areas: [region] });
  let failed;
  for (let i = 0; i < 120 && failed?.state !== "failed"; i++) { failed = (await fh.get(`/api/trips/${F}`)).json?.tiles; await new Promise((r) => setTimeout(r, 250)); }
  t.same("the world build unreachable: the areas write still answers, the map is \"failed\" with what happened, and the app draws its own ground",
    [areasAnswer.status, failed?.state, /couldn't be made/.test(failed?.note ?? "")], [200, "failed", true]);
  const planNoWorld = await fh.post(`/api/trips/${F}/tiles/plan`, { areas: [region] });
  t.same("and a plan there answers 503 \"world unreachable\", in words", [planNoWorld.status, planNoWorld.json?.error, !!planNoWorld.json?.reason], [503, "world unreachable", true]);
  const tooFull = await fh.post(`/api/trips/${F}/media/begin`, { name: "big.pmtiles", mime: "application/vnd.pmtiles", bytes: 5 * 1024 * 1024, kind: "map" });
  t.same("an uploaded map that doesn't fit the host's storage is refused before a byte moves, as any file is", [tooFull.status, tooFull.json?.error], [413, "storage full"]);

  t.part("7. A map uploaded (option 4): the host's, counted against their storage");
  const V = (await host.post("/api/trips", { name: "Uploaded map", default_tz: "UTC" })).json.trip.id;
  const vlink = await host.post(`/api/trips/${V}/links`, { uses: 1 });
  await guest.post(`/api/join/${vlink.json.link.code}`);
  await host.call("PUT", `/api/trips/${V}/areas`, { areas: [region] });
  const cutV = await until((x) => x?.state === "ready", 60000, V);
  const mapFile = expected;            // a real archive: the module's cut of the same region
  const tool = (env) => run(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "../../tools/map-upload.mjs"), mapFile, "--trip", V, "--base", server.origin], { env: { PATH: process.env.PATH, ...env } })
    .then((r) => ({ code: 0, out: r.stdout + r.stderr }), (e) => ({ code: e.code, out: String(e.stdout) + String(e.stderr) }));
  const noSession = await tool({});
  t.ok("the upload tool refuses without WGP_SESSION, saying where it comes from", noSession.code === 2 && /WGP_SESSION/.test(noSession.out), noSession.out);
  const sent = await tool({ WGP_SESSION: host.jar.cookies.get("wgp_session") });
  const up = await tilesNow(host, V);
  const size = fs.statSync(mapFile).size;
  t.same("the host uploads one with the tool: it is the trip's map, made by an upload, its size the file's, a new version",
    [sent.code, up?.source, up?.bytes, up?.state, up?.version !== cutV?.version], [0, "upload", size, "ready", true]);
  t.ok("  (the host's session is in none of its output)", !sent.out.includes(host.jar.cookies.get("wgp_session")));
  const meterV = (await host.get("/api/account/storage")).json?.trips?.find((x) => x.id === V);
  t.same("it counts against the host's storage, on the meter as the trip's map", [meterV?.map?.bytes, meterV?.bytes >= size], [size, true]);
  t.same("  (the cut it replaced goes to the drain)", server.sql(`SELECT COUNT(*) AS n FROM files_to_delete WHERE bucket = 'tiles' AND r2_key = 'trips/${V}/${cutV.version}.pmtiles'`)[0].n, 1);
  const gotUp = await fetch(`${server.origin}/api/trips/${V}/tiles`, { headers: { Cookie: guest.jar.header(), "CF-Connecting-IP": guest.address } });
  t.same("the trip's tiles address serves the uploaded map to someone on the trip, the file's bytes", Buffer.compare(Buffer.from(await gotUp.arrayBuffer()), fs.readFileSync(mapFile)), 0);
  await host.call("PUT", `/api/trips/${V}/areas`, { areas: [{ ...region, north: region.north + 0.01 }] });
  await new Promise((r) => setTimeout(r, 2500));
  t.same("an areas write doesn't replace an uploaded map", (await tilesNow(host, V))?.version, up?.version);
  const goesV = await host.call("DELETE", `/api/trips/${V}`, { confirm: "not its name" });
  t.same("  (the delete dialog's numbers carry it)", goesV.json?.goes?.map_bytes, size);
  const mapKey = server.sql(`SELECT tiles FROM trips WHERE id = '${V}'`)[0].tiles;
  const keep = await host.call("DELETE", `/api/trips/${V}/media/object?key=${encodeURIComponent(mapKey)}`);
  t.same("its file can't be deleted while it is the trip's map, in words", [keep.status, keep.json?.error, Boolean(keep.json?.reason)], [409, "the trip's map", true]);
  const guestBegin = await guest.post(`/api/trips/${V}/media/begin`, { name: "m.pmtiles", mime: "application/vnd.pmtiles", bytes: 1000, kind: "map" });
  const tooBig = await host.post(`/api/trips/${V}/media/begin`, { name: "m.pmtiles", mime: "application/vnd.pmtiles", bytes: 300 * 1024 * 1024, kind: "map" });
  t.same("someone not the host can't upload a map; one past 200 MB is refused, saying what to do", [guestBegin.status, tooBig.status, /Cut a smaller area/.test(tooBig.json?.reason ?? "")], [403, 413, true]);
  // A file that isn't an archive, sent as a map.
  const junk = Buffer.from("not a map at all, just words ".repeat(20));
  const jb = await host.post(`/api/trips/${V}/media/begin`, { name: "junk.pmtiles", mime: "application/vnd.pmtiles", bytes: junk.length, kind: "map" });
  const jp = await host.call("PUT", `/api/trips/${V}/media/part?key=${encodeURIComponent(jb.json.key)}&id=${encodeURIComponent(jb.json.uploadId)}&n=1`, junk, { headers: { "Content-Type": "application/octet-stream" } });
  await host.post(`/api/trips/${V}/media/finish`, { key: jb.json.key, id: jb.json.uploadId, parts: [{ n: 1, etag: jp.json?.etag }] });
  const junkUse = await host.post(`/api/trips/${V}/tiles/use`, { key: jb.json.key });
  t.same("a file that isn't a map is refused as the trip's map, in words; the map stays", [junkUse.status, junkUse.json?.error, (await tilesNow(host, V))?.version], [400, "not a map", up?.version]);

  // A person's own file is opened with the reader, and three numbers in it would be believed: where
  // the root is and how long, how many entries a directory has, how big its packed root unpacks to.
  // Each planted as an upload: "not a map" in words, quickly, and the Worker's memory unmoved.
  {
  const VECTOR_TILE = 1;   // PMTiles' tile type for vector tiles
  const head = (over) => writeHeader({ rootOffset: 127, rootLength: 0, metadataOffset: 0, metadataLength: 0, leafOffset: 0, leafLength: 0, dataOffset: 0, dataLength: 0,
    addressedTiles: 1, tileEntries: 1, tileContents: 1, clustered: true, internalCompression: COMPRESSION.none, tileCompression: COMPRESSION.gzip, tileType: VECTOR_TILE,
    minZoom: 0, maxZoom: 14, minLon: -10, minLat: 35, maxLon: 5, maxLat: 44, centerZoom: 0, centerLon: -2, centerLat: 40, ...over });
  const file = (over, root) => Buffer.concat([Buffer.from(head({ ...over, rootLength: over.rootLength ?? root.length })), Buffer.from(root)]);
  const bomb = Buffer.from(await gzip(new Uint8Array(8 * 1024 * 1024)));
  const planted = [
    ["a root named past its first 16 KiB, half a gigabyte long", file({ rootOffset: 20000, rootLength: 500_000_000 }, new Uint8Array(64)), /first 16 KiB/],
    ["a directory claiming 2^28 entries in 5 bytes", file({}, [0x80, 0x80, 0x80, 0x80, 0x01]), /says it holds \d+ entries in \d+ bytes/],
    [`a packed root of ${(bomb.length / 1024).toFixed(0)} KiB that unpacks to 8 MiB`, file({ internalCompression: COMPRESSION.gzip }, bomb), /unpacks to more than/],
    ["a number twelve bytes long", file({}, new Uint8Array(12).fill(0xff)), /longer than ten bytes/],
  ];
  for (const [what, bytes, said] of planted) {
    const pb = await host.post(`/api/trips/${V}/media/begin`, { name: "planted.pmtiles", mime: "application/vnd.pmtiles", bytes: bytes.length, kind: "map" });
    const pp = await host.call("PUT", `/api/trips/${V}/media/part?key=${encodeURIComponent(pb.json.key)}&id=${encodeURIComponent(pb.json.uploadId)}&n=1`, bytes, { headers: { "Content-Type": "application/octet-stream" } });
    await host.post(`/api/trips/${V}/media/finish`, { key: pb.json.key, id: pb.json.uploadId, parts: [{ n: 1, etag: pp.json?.etag }] });
    const before = rss();
    let peak = before;
    const sample = setInterval(() => { try { peak = Math.max(peak, rss()); } catch { /* gone */ } }, 20);
    const t0 = Date.now();
    const used = await host.post(`/api/trips/${V}/tiles/use`, { key: pb.json.key });
    clearInterval(sample);
    const took = Date.now() - t0, grew = (peak - before) / 1e6;
    t.ok(`${what}: "not a map", saying why (${took} ms; the Worker grew ${grew.toFixed(1)} MB)`,
      used.status === 400 && used.json?.error === "not a map" && said.test(used.json?.reason ?? "") && took < 3000 && grew < 32, `${used.status} ${used.json?.reason ?? used.text}`.slice(0, 300));
    await host.call("DELETE", `/api/trips/${V}/media/object?key=${encodeURIComponent(pb.json.key)}`);
  }
  }
  await host.post(`/api/trips/${V}/tiles/cut`);
  const recut = await until((x) => x?.state === "ready" && x.source === "cut", 60000, V);
  t.same("the host asks for a cut: the uploaded map goes, its file row with it (the storage frees), its file to the drain",
    [recut?.source, server.sql(`SELECT COUNT(*) AS n FROM media_objects WHERE r2_key = '${mapKey}'`)[0].n, server.sql(`SELECT bucket FROM files_to_delete WHERE r2_key = '${mapKey}'`)[0]?.bucket,
      (await host.get("/api/account/storage")).json?.trips?.find((x) => x.id === V)?.map?.bytes], ["cut", 0, "media", junk.length]);
  t.same("  (the file that wasn't a map still counts as the host's, until they delete it: then nothing of a map counts)",
    [(await host.call("DELETE", `/api/trips/${V}/media/object?key=${encodeURIComponent(jb.json.key)}`)).status, (await host.get("/api/account/storage")).json?.trips?.find((x) => x.id === V)?.map?.bytes], [200, 0]);

  t.part("8. The label fonts, whole, for any destination (tools/fonts-upload.mjs)");
  const { RANGES, problemsIn, styleFonts } = await import("../../tools/fonts-upload.mjs");
  const fontsDir = path.join(work, "fonts");
  const named = styleFonts();
  const glyph = Buffer.from([0x0a, 0x03, 0x41, 0x42, 0x43]);
  for (const f of named) { fs.mkdirSync(path.join(fontsDir, f), { recursive: true }); for (const r of RANGES) fs.writeFileSync(path.join(fontsDir, f, `${r}.pbf`), glyph); }
  fs.writeFileSync(path.join(fontsDir, "OFL.txt"), "licence");
  const fontsWhole = problemsIn(fontsDir, named);
  fs.rmSync(path.join(fontsDir, named[0], "512-767.pbf"));
  fs.writeFileSync(path.join(fontsDir, named[1], "0-255.pbf"), "<html>not a glyph file</html>");
  fs.rmSync(path.join(fontsDir, "OFL.txt"));
  const broken = problemsIn(fontsDir, [...named, "Noto Sans Planted"]);
  t.same(`the fonts the style names (${named.join(", ")}): a whole folder passes; a missing range, a file that isn't glyphs, a font missing and no licence are each refused by name`,
    [fontsWhole, broken.length, broken.some((x) => /lacks 1 ranges/.test(x)), broken.some((x) => /isn't a glyph file/.test(x)), broken.some((x) => /Noto Sans Planted/.test(x)), broken.some((x) => /OFL/.test(x))],
    [[], 4, true, true, true, true]);
  const fontKey = `fonts/${named.find((f) => /Regular$/.test(f)) ?? named[0]}/768-1023.pbf`;
  const fontFile = path.join(work, "glyph.pbf");
  fs.writeFileSync(fontFile, glyph);
  server.put("wegoplace-tiles", fontKey, fontFile);
  const fontServed = await host.get(`/tiles/${fontKey.split("/").map(encodeURIComponent).join("/")}`);
  t.same("a range in the bucket is served where the map asks for it (/tiles/fonts/<font>/<range>.pbf)", [fontServed.status, fontServed.text?.length], [200, glyph.length]);

  // Sending them: --jobs at a time, the upFirst failure stops it, and a second run starts where the
  // upFirst stopped (tools/fonts-upload.mjs sendAll(), here with a stand-in for wrangler's put).
  const { sendAll } = await import("../../tools/fonts-upload.mjs");
  const upDir = path.join(work, "up");
  fs.mkdirSync(upDir);
  const upFiles = Array.from({ length: 40 }, (_, i) => { const f = path.join(upDir, `${i}.pbf`); fs.writeFileSync(f, Buffer.concat([glyph, Buffer.from([i])])); return [`fonts/k${i}`, f]; });
  const doneFile = path.join(work, "fonts.done");
  const doneLines = () => (fs.existsSync(doneFile) ? fs.readFileSync(doneFile, "utf8").trim().split("\n").filter(Boolean).length : 0);
  let inFlight = 0;
  let most = 0;
  const started = [];
  const put = (failAt = null) => async (key) => {
    started.push(key);
    inFlight += 1; most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    if (key === failAt) throw new Error("connection reset");
  };
  const upFirst = await sendAll(upFiles, { put: put(), jobs: 8, doneFile });
  t.same("40 files sent 8 at a time at most, each written down as it lands", [upFirst.sent, upFirst.skipped, upFirst.failed, most, doneLines()], [40, 0, null, 8, 40]);
  const upAgain = await sendAll(upFiles, { put: put(), jobs: 8, doneFile });
  t.same("a second run sends nothing that's already there", [upAgain.sent, upAgain.skipped], [0, 40]);
  fs.rmSync(doneFile);
  started.length = 0;
  const upBroke = await sendAll(upFiles, { put: put("fonts/k12"), jobs: 4, doneFile });
  t.same("a failure stops it: it names the file and wrangler's words, nothing new starts after it, and what landed is written down",
    [upBroke.failed, started.length <= 13 + 3, upBroke.sent === doneLines(), upBroke.sent < 40], [{ key: "fonts/k12", words: "connection reset" }, true, true, true]);
  const upResumed = await sendAll(upFiles, { put: put(), jobs: 4, doneFile });
  t.same("run again, it starts where it stopped: what landed is skipped, the rest (the failed one too) goes", [upResumed.skipped, upResumed.sent, upResumed.failed, doneLines()], [upBroke.sent, 40 - upBroke.sent, null, 40]);
  fs.appendFileSync(upFiles[5][1], Buffer.from([0xff]));
  const upChanged = await sendAll(upFiles, { put: put(), jobs: 4, doneFile });
  t.same("a file whose contents changed goes again; the rest are skipped", [upChanged.sent, upChanged.skipped], [1, 39]);

  t.part("Underneath");
  const broke = [server, failing].flatMap((s) => s.log().split("\n")).filter((l) => /Uncaught|✘|\[ERROR\]/.test(l));
  t.ok("nothing failed inside the servers", broke.length === 0, broke.slice(0, 6).join("\n        "));
  code = t.end();
} catch (error) {
  console.error(error instanceof CheckError ? `\nCAN'T RUN: ${error.message}` : error);
  t.end();
  code = 2;
} finally {
  await world?.stop();
  await server?.stop();
  await failing?.stop();
  await planning?.stop();
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(code);
