// A stand-in world with real places in it, for the checks of find_places, find_picture and the bake-off's planning
// tasks (tools/bakeoff/round-2b.mjs): a PMTiles archive of z15 vector tiles whose "pois" layer holds PLACES (made up and
// set at real positions in central Amsterdam, and a few real ones where the real build has them), written as Protomaps writes them (layer "pois", tags name and
// kind, one point each). Served by range from this machine (checks/map/world.mjs), so the app reads it exactly as it
// reads the world build. And a stand-in for Wikidata and Commons (WIKIMEDIA_API_VIA), whose photos are the far-site
// stand-in's own Wikimedia file (checks/lib/far.mjs), so set_picture fetches it as it would the real one.
// Never the network. Every place and photo here is made up.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { encodeDirectory, gzip, writeHeader, zxyToTileId, COMPRESSION } from "../../src/map/pmtiles.js";
import { POI_ZOOM, tileOf } from "../../src/map/pois.js";
import { serveWorld } from "../map/world.mjs";

/** The made-up places, at real positions in central Amsterdam. The hotel is where find-near starts. */
export const PLACES = [
  { name: "Hotel Lindegracht", kind: "hotel", lat: 52.37452, lng: 4.88512 },
  { name: "Bakkerij Ochtendgloren", kind: "bakery", lat: 52.37522, lng: 4.88691 },
  { name: "Broodhuis De Zon", kind: "bakery", lat: 52.37172, lng: 4.88301 },
  { name: "Museum Het Waaghuis", kind: "museum", lat: 52.37271, lng: 4.90032 },
  { name: "Stadsmuseum Amstelkade", kind: "museum", lat: 52.36021, lng: 4.88902 },
  { name: "Grachtenmuseum Noord", kind: "museum", lat: 52.37903, lng: 4.89503 },
  { name: "Scheepvaarthuis Oost", kind: "museum", lat: 52.37121, lng: 4.91502 },
  { name: "Eetcafé De Brug", kind: "restaurant", lat: 52.37351, lng: 4.89203 },
  { name: "Restaurant Tulpenveld", kind: "restaurant", lat: 52.36603, lng: 4.88804 },
  { name: "Keuken van Kaas", kind: "restaurant", lat: 52.37702, lng: 4.88903 },
  { name: "Bistro Amstelhof", kind: "restaurant", lat: 52.36404, lng: 4.90102 },
  { name: "Proeflokaal Het Anker", kind: "bar", lat: 52.37203, lng: 4.89602 },
  { name: "Koffiehuis Mokum", kind: "cafe", lat: 52.37004, lng: 4.89003 },
  { name: "Café De Vier Winden", kind: "cafe", lat: 52.36802, lng: 4.89304 },
  { name: "Vondelhof Park", kind: "park", lat: 52.35803, lng: 4.86904 },
  // Real public places at their positions in the world build (20261118), for the import task's document
  // (tools/bakeoff/documents/): one document then reads the same in a dry run and a real one.
  { name: "Rijksmuseum", kind: "museum", lat: 52.359843, lng: 4.88504 },
  { name: "Van Gogh Museum", kind: "museum", lat: 52.358367, lng: 4.881089 },
  { name: "Anne Frank Huis", name_en: "Anne Frank House", kind: "museum", lat: 52.375155, lng: 4.88408 },
  { name: "Foodhallen", kind: "food_court", lat: 52.366948, lng: 4.868199 },
  { name: "Rijks", kind: "restaurant", lat: 52.359598, lng: 4.884292 },
  { name: "Die Port van Cleve", kind: "hotel", lat: 52.374062, lng: 4.8906 },
  { name: "Vondelpark", kind: "park", lat: 52.357197, lng: 4.864119 },
];
/**
 * The places with a photo in the Wikimedia stand-in: each file's original (the far-site stand-in's own Wikimedia files,
 * checks/lib/far.mjs). The Waaghuis's is 3000 × 2000, too big for set_picture, so only Commons' 1280-wide sized copy
 * fits; the Amstelkade's is 1200 × 800 and is used whole; the Grachtenmuseum's isn't free (kept out by find_picture).
 */
const BIG = { url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Big.png", width: 3000, height: 2000 };
const SMALL = { url: "https://upload.wikimedia.org/wikipedia/commons/c/cd/Small.png", width: 1200, height: 800 };
export const PHOTOS = {
  "Museum Het Waaghuis": { id: "Q900001", file: "Waaghuis.png", original: BIG, license: "CC BY-SA 4.0", artist: "<a href=\"//commons.wikimedia.org/wiki/User:Lens\">A. Lens</a>" },
  "Stadsmuseum Amstelkade": { id: "Q900002", file: "Amstelkade.png", original: SMALL, license: "CC0", artist: "Studio Kade" },
  "Grachtenmuseum Noord": { id: "Q900003", file: "Grachtenmuseum.png", original: SMALL, license: "CC BY-NC 2.0", artist: "Not Free" },
};
/** Commons' sized copy of an original at a width, by its address, as Commons names it. */
export const sizedCopy = (original, width) => original.url.replace(/\/wikipedia\/commons\/(\w)\/(\w\w)\/([^/]+)$/, `/wikipedia/commons/thumb/$1/$2/$3/${width}px-$3`);
/** What find_picture answers for the Waaghuis, and what set_picture is given for it: its 1280-wide copy. */
export const PHOTO_URL = sizedCopy(BIG, 1280);

// ── a vector tile, written ──────────────────────────────────────────────────────────────────

const EXTENT = 4096;
function varint(out, n) { while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } out.push(n); }
const zig = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
function field(out, num, wire, payload) {
  varint(out, num * 8 + wire);
  if (wire === 0) varint(out, payload);
  else { varint(out, payload.length); out.push(...payload); }
}
const utf8 = (s) => [...new TextEncoder().encode(s)];

/** One z15 tile's "pois" layer, its places as points (tags name, kind and, where a place has one, name:en), as Protomaps writes it. */
export function poisTile(places, z, x, y) {
  const keys = ["name", "kind", "name:en"], values = [];
  const valueIndex = (s) => { let i = values.indexOf(s); if (i < 0) { values.push(s); i = values.length - 1; } return i; };
  const features = places.map((p) => {
    const n = 2 ** z;
    const px = Math.round((((p.lng + 180) / 360) * n - x) * EXTENT);
    const r = (p.lat * Math.PI) / 180;
    const py = Math.round((((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n - y) * EXTENT);
    const f = [];
    const tags = [];
    varint(tags, 0); varint(tags, valueIndex(p.name)); varint(tags, 1); varint(tags, valueIndex(p.kind));
    if (p.name_en) { varint(tags, 2); varint(tags, valueIndex(p.name_en)); }
    field(f, 2, 2, tags);
    field(f, 3, 0, 1);
    const g = [];
    varint(g, (1 << 3) | 1); varint(g, zig(px)); varint(g, zig(py));
    field(f, 4, 2, g);
    return f;
  });
  const layer = [];
  field(layer, 15, 0, 2);
  field(layer, 1, 2, utf8("pois"));
  for (const f of features) field(layer, 2, 2, f);
  for (const k of keys) field(layer, 3, 2, utf8(k));
  for (const v of values) { const val = []; field(val, 1, 2, utf8(v)); field(layer, 4, 2, val); }
  field(layer, 5, 0, EXTENT);
  const tile = [];
  field(tile, 3, 2, layer);
  return Uint8Array.from(tile);
}

/** A PMTiles archive of z15 tiles holding `places`, written to `file`. */
export async function writePoisWorld(file, places = PLACES) {
  const byTile = new Map();
  for (const p of places) {
    const t = tileOf(p.lat, p.lng, POI_ZOOM);
    const id = zxyToTileId(t.z, t.x, t.y);
    (byTile.get(id) ?? byTile.set(id, { t, places: [] }).get(id)).places.push(p);
  }
  const ids = [...byTile.keys()].sort((a, b) => a - b);
  const tiles = [];
  for (const id of ids) { const { t, places: ps } = byTile.get(id); tiles.push({ id, bytes: await gzip(poisTile(ps, t.z, t.x, t.y)) }); }
  let offset = 0;
  const entries = tiles.map((t) => { const e = { tileId: t.id, offset, length: t.bytes.length, runLength: 1 }; offset += t.bytes.length; return e; });
  const root = await gzip(encodeDirectory(entries));
  const metadata = await gzip(new TextEncoder().encode(JSON.stringify({ name: "stand-in world with places", vector_layers: [{ id: "pois", fields: { name: "String", kind: "String" } }] })));
  const lats = places.map((p) => p.lat), lngs = places.map((p) => p.lng);
  const h = {
    rootOffset: 127, rootLength: root.length, metadataOffset: 127 + root.length, metadataLength: metadata.length,
    leafOffset: 127 + root.length + metadata.length, leafLength: 0, dataOffset: 127 + root.length + metadata.length, dataLength: offset,
    addressedTiles: tiles.length, tileEntries: tiles.length, tileContents: tiles.length, clustered: true,
    internalCompression: COMPRESSION.gzip, tileCompression: COMPRESSION.gzip, tileType: 1, minZoom: POI_ZOOM, maxZoom: POI_ZOOM,
    minLon: Math.min(...lngs), minLat: Math.min(...lats), maxLon: Math.max(...lngs), maxLat: Math.max(...lats),
    centerZoom: POI_ZOOM, centerLon: lngs[0], centerLat: lats[0],
  };
  const parts = [writeHeader(h), root, metadata, ...tiles.map((t) => t.bytes)];
  fs.writeFileSync(file, Buffer.concat(parts.map((p) => Buffer.from(p))));
  return file;
}

/** The stand-in world, written to a temporary file and served by range: { url, served, stop }. */
export async function startPoisWorld(places = PLACES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wgp-pois-world-"));
  const file = await writePoisWorld(path.join(dir, "world.pmtiles"), places);
  const world = await serveWorld(file);
  return { ...world, stop: async () => { await world.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ── Wikidata and Commons, stood in for ─────────────────────────────────────────────────────

/** The stand-in Wikimedia APIs (WIKIMEDIA_API_VIA): { url, heard (every address asked, with its User-Agent), stop }. */
export async function startWikimedia(places = PLACES, photos = PHOTOS) {
  const heard = [];
  const server = http.createServer((req, res) => {
    const asked = String(req.headers["x-fetch-for"] ?? "");
    heard.push({ asked, agent: String(req.headers["user-agent"] ?? "") });
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    let u;
    try { u = new URL(asked); } catch { return send(400, { error: "no X-Fetch-For" }); }
    const q = u.searchParams;
    if (u.hostname === "www.wikidata.org" && q.get("action") === "wbsearchentities") {
      const want = String(q.get("search") ?? "").toLowerCase();
      const hits = Object.entries(photos).filter(([name]) => name.toLowerCase().includes(want) || want.includes(name.toLowerCase()));
      return send(200, { search: hits.map(([name, p]) => ({ id: p.id, label: name, match: { text: name } })) });
    }
    if (u.hostname === "www.wikidata.org" && q.get("action") === "wbgetentities") {
      const entities = {};
      for (const id of String(q.get("ids") ?? "").split("|")) {
        const [name, p] = Object.entries(photos).find(([, x]) => x.id === id) ?? [];
        const place = places.find((x) => x.name === name);
        if (!place) continue;
        entities[id] = { claims: {
          P625: [{ mainsnak: { datavalue: { value: { latitude: place.lat, longitude: place.lng } } } }],
          P18: [{ mainsnak: { datavalue: { value: p.file } } }],
        } };
      }
      return send(200, { entities });
    }
    if (u.hostname === "commons.wikimedia.org" && q.get("action") === "query") {
      const file = String(q.get("titles") ?? "").replace(/^File:/, "");
      const own = Object.values(photos).find((x) => x.file === file);
      if (!own) return send(200, { query: { pages: [{ title: `File:${file}`, missing: true }] } });
      // As Commons answers: the original, its size, and the sized copy asked for (the original itself when it's no
      // wider than that), each address with Commons' tracking query.
      const o = own.original, w = Number(q.get("iiurlwidth")) || 0;
      const thumb = w && w < o.width ? sizedCopy(o, w) : o.url;
      return send(200, { query: { pages: [{ title: `File:${file}`, imageinfo: [{ url: `${o.url}?utm_source=commons.wikimedia.org`, width: o.width, height: o.height,
        ...(w ? { thumburl: `${thumb}?utm_source=commons.wikimedia.org`, thumbwidth: Math.min(w, o.width), thumbheight: Math.round(Math.min(w, o.width) * o.height / o.width) } : {}),
        descriptionurl: `https://commons.wikimedia.org/wiki/File:${file}`, extmetadata: { LicenseShortName: { value: own.license }, Artist: { value: own.artist } } }] }] } });
    }
    return send(404, { error: "not stood in" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/`, heard, stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
