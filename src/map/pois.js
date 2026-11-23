// Real places from the map's own data: the points of interest in the world build a trip's map is cut from
// (Protomaps' daily build of OpenStreetMap, src/map/cut.js), read at street level (z15), where each one carries a name,
// a kind ("bakery", "museum", "restaurant" …) and its position. The assistant's find_places tool reads it, and the
// bake-off checks a written place against it.
//
// NEVER COMPLETE. Protomaps keeps the more important points at each zoom, so a tile holds some of the places in it,
// not all: what this finds is real, and what it doesn't find may still exist. Callers say so.
//
// Pure: nothing here knows about Workers, caches or the network. Tiles come from a `getTile(z, x, y)` the caller
// gives (bytes, already decompressed, or null), so the same code runs in the Worker and in Node.
//
// A vector tile (Mapbox Vector Tile 2.1) is a protocol buffer: layers (field 3), each with its name (1), features
// (2), keys (3), values (4) and extent (5); a feature has tags (2: pairs of key and value indexes) and geometry (4:
// command integers, (count << 3) | id, MoveTo = 1, each followed by zigzag-encoded x, y deltas in tile units).

export const POI_ZOOM = 15;
export const POI_LAYER = "pois";
/**
 * How far a search reaches at most, and by default; how many places it answers at most, and by default; and how many
 * z15 tiles one search reads at most (a z15 tile is ~750 m wide at Amsterdam's latitude, narrower toward the poles: a
 * wide radius is cut until its tiles fit, and the answer says to what).
 */
export const NEAR = { radiusMax: 3000, radiusDefault: 800, limitMax: 25, limitDefault: 10, tilesMax: 16, namesMax: 20, perNameDefault: 3 };

const decoder = new TextDecoder();

function varint(b, p) {
  let r = 0, s = 0, x;
  do { x = b[p.i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80 && p.i < b.length);
  return r;
}
function fields(b) {
  const out = [];
  const p = { i: 0 };
  while (p.i < b.length) {
    const key = varint(b, p), field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) out.push({ field, value: varint(b, p) });
    else if (wire === 2) { const n = varint(b, p); out.push({ field, value: b.subarray(p.i, p.i + n) }); p.i += n; }
    else if (wire === 1) { out.push({ field, value: b.subarray(p.i, p.i + 8) }); p.i += 8; }
    else if (wire === 5) { out.push({ field, value: b.subarray(p.i, p.i + 4) }); p.i += 4; }
    else throw new Error(`a vector tile with wire type ${wire}, which it never uses`);
  }
  return out;
}
const zigzag = (n) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2);
function valueOf(b) {
  const f = fields(b)[0];
  if (!f) return null;
  if (f.field === 1) return decoder.decode(f.value);
  if (f.field === 2) return new DataView(f.value.buffer, f.value.byteOffset, 4).getFloat32(0, true);
  if (f.field === 3) return new DataView(f.value.buffer, f.value.byteOffset, 8).getFloat64(0, true);
  if (f.field === 4 || f.field === 5) return f.value;
  if (f.field === 6) return zigzag(f.value);
  if (f.field === 7) return f.value === 1;
  return null;
}

/** A point in a tile (its own units, 0..extent) as longitude and latitude. */
export function tilePointToLngLat(z, x, y, px, py, extent) {
  const n = 2 ** z;
  const lng = ((x + px / extent) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / extent)) / n))) * 180) / Math.PI;
  return { lat, lng };
}

/** The tile a point is in, at a zoom. */
export function tileOf(lat, lng, z) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { z, x: Math.floor(((lng + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
}

/**
 * Every point of interest in a decoded tile: { name, names (every name:* it carries), kind, kind_detail, lat, lng }.
 * A feature with several points (a multipoint) is one place at its first point; an unnamed one is skipped.
 */
export function poisInTile(tile, z, x, y) {
  const out = [];
  for (const l of fields(tile).filter((f) => f.field === 3)) {
    const parts = fields(l.value);
    const nameField = parts.find((f) => f.field === 1);
    if (!nameField || decoder.decode(nameField.value) !== POI_LAYER) continue;
    const extent = parts.find((f) => f.field === 5)?.value ?? 4096;
    // A tile repeats its neighbours' points near its edge (its buffer): only its own are its.
    const keys = parts.filter((f) => f.field === 3).map((f) => decoder.decode(f.value));
    const values = parts.filter((f) => f.field === 4).map((f) => valueOf(f.value));
    for (const feature of parts.filter((f) => f.field === 2)) {
      const ff = fields(feature.value);
      const tagBytes = ff.find((f) => f.field === 2)?.value;
      const geometry = ff.find((f) => f.field === 4)?.value;
      if (!tagBytes || !geometry) continue;
      const tags = {};
      const p = { i: 0 };
      while (p.i < tagBytes.length) { const k = varint(tagBytes, p), v = varint(tagBytes, p); tags[keys[k]] = values[v]; }
      if (typeof tags.name !== "string" || !tags.name.trim()) continue;
      const g = { i: 0 };
      const command = varint(geometry, g);
      if ((command & 0x7) !== 1 || command >> 3 < 1) continue;
      const px = zigzag(varint(geometry, g)), py = zigzag(varint(geometry, g));
      if (px < 0 || py < 0 || px >= extent || py >= extent) continue;
      const { lat, lng } = tilePointToLngLat(z, x, y, px, py, extent);
      const names = [...new Set(Object.entries(tags).filter(([k, v]) => (k === "name" || k.startsWith("name:")) && typeof v === "string").map(([, v]) => v))];
      out.push({ name: tags.name, names, kind: typeof tags.kind === "string" ? tags.kind : null, kind_detail: typeof tags.kind_detail === "string" ? tags.kind_detail : null, lat, lng });
    }
  }
  return out;
}

/** Metres between two points (haversine). */
export function distanceM(a, b) {
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The z15 tiles a circle touches: its bounding box's tiles (poisNear keeps their count to NEAR.tilesMax). */
export function tilesAround(lat, lng, radiusM, z = POI_ZOOM) {
  const dLat = radiusM / 111_000, dLng = radiusM / (111_000 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const nw = tileOf(Math.min(85, lat + dLat), lng - dLng, z), se = tileOf(Math.max(-85, lat - dLat), lng + dLng, z);
  const out = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) out.push({ z, x, y });
  return out;
}

/** A name as a person compares it: no accents, no case, no punctuation, "&" as "and", one space between words. */
export const plainName = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/&/g, " and ")
  .replace(/['’`´]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Whether two names name the same place, as a person would read them: the same words, or every word of the
 * shorter one in the longer ("Rijksmuseum" and "Rijksmuseum Amsterdam"), the shorter at least 4 letters.
 */
export function sameName(a, b) {
  const x = plainName(a), y = plainName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.replace(/ /g, "").length < 4) return false;
  const words = new Set(long.split(" "));
  return short.split(" ").every((w) => words.has(w));
}

/** The box (west, south, east, north, in degrees, to 6 places) around a circle of radius_m metres: it holds every point of the circle. */
export function boxAround(lat, lng, radius_m) {
  const dLat = radius_m / 111_000; // a little under a degree's length (111,195 m on the sphere distanceM uses), so the box always holds the circle
  const dLng = radius_m / (111_000 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const r = (x) => Math.round(x * 1e6) / 1e6;
  return { west: r(Math.max(-180, lng - dLng)), south: r(Math.max(-85, lat - dLat)), east: r(Math.min(180, lng + dLng)), north: r(Math.min(85, lat + dLat)) };
}

/**
 * Points of interest near a spot, nearest first: { places: [{ name, kind, kind_detail, lat, lng, distance_m }],
 * tiles (how many were read), radius_m (the radius searched), cut (true when the radius asked was cut to fit
 * NEAR.tilesMax tiles) }. kinds: only these kinds (or kind_detail); name: only places whose name matches it.
 * Duplicates (the same name within 30 m) are one place. names (a list): the same tiles read once, and { byName: [{ name,
 * places }] } in place of places, each name's own matches (at most `limit`, NEAR.perNameDefault when not given).
 */
export async function poisNear(getTile, { lat, lng, radius_m = NEAR.radiusDefault, kinds = null, name = null, limit = NEAR.limitDefault, names = null }) {
  // Several names (find_places' names): the tiles read once, every place kept, then each name's own answer below.
  if (names?.length) {
    const all = await poisNear(getTile, { lat, lng, radius_m, kinds, limit: Number.MAX_SAFE_INTEGER });
    const each = Math.min(Math.max(1, Number(limit) || NEAR.perNameDefault), NEAR.limitMax);
    return { byName: names.map((n) => ({ name: n, places: all.places.filter((p) => p.names.some((x) => sameName(x, n))).slice(0, each) })), tiles: all.tiles, radius_m: all.radius_m, cut: all.cut };
  }
  const asked = Math.min(Math.max(1, Number(radius_m) || NEAR.radiusDefault), NEAR.radiusMax);
  let radius = asked;
  while (radius > 50 && tilesAround(lat, lng, radius).length > NEAR.tilesMax) radius = Math.floor(radius * 0.85);
  const want = kinds?.length ? new Set(kinds.map((k) => String(k).toLowerCase())) : null;
  const tiles = tilesAround(lat, lng, radius);
  const found = [];
  for (const t of tiles) {
    const tile = await getTile(t.z, t.x, t.y);
    if (!tile) continue;
    for (const p of poisInTile(tile, t.z, t.x, t.y)) {
      const d = distanceM({ lat, lng }, p);
      if (d > radius) continue;
      if (want && !want.has(String(p.kind ?? "").toLowerCase()) && !want.has(String(p.kind_detail ?? "").toLowerCase())) continue;
      if (name && !p.names.some((n) => sameName(n, name))) continue;
      if (found.some((q) => plainName(q.name) === plainName(p.name) && distanceM(q, p) < 30)) continue;
      found.push({ name: p.name, kind: p.kind, kind_detail: p.kind_detail, lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6), distance_m: Math.round(d), names: p.names });
    }
  }
  found.sort((a, b) => a.distance_m - b.distance_m);
  return { places: found.slice(0, limit === Number.MAX_SAFE_INTEGER ? found.length : Math.min(Math.max(1, Number(limit) || NEAR.limitDefault), NEAR.limitMax)), tiles: tiles.length, radius_m: radius, cut: radius < asked };
}

/**
 * Whether a written place is real: a point of interest within `within` metres of where it was written whose name
 * (any of its names) matches the place's name or its local name. Answers the match or null.
 */
export async function realPlace(getTile, place, within = 150) {
  if (!Number.isFinite(place?.lat) || !Number.isFinite(place?.lng)) return null;
  const { places } = await poisNear(getTile, { lat: place.lat, lng: place.lng, radius_m: within, limit: NEAR.limitMax });
  return places.find((p) => p.names.some((n) => sameName(n, place.name) || (place.name_local && sameName(n, place.name_local)))) ?? null;
}
