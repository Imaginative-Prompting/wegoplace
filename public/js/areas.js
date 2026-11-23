// The trip's areas, read: the words for a place's area, and the regions the map names and
// shades. Places and the map both ask here, so the two never word one area two ways.
//
// An area is a row of the trip (docs/API.md § Areas):
//   { id, name, parent, west, south, east, north, sort }
// A top-level area is a region ("Lisbon"); a child is a neighborhood under it ("Alfama").
// Bounds are all four edges or none, in degrees. West greater than east is a box that crosses
// the 180° line (west 177, east -178): a place at 179.5 or at -179.5 is inside it.
//
// Pure functions over the rows: no store and no DOM, so node checks them
// (scripts/areas_check.mjs).

const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

/** The same meridian as `lng`, written within 180° of `ref`: 179 seen from -179 is -181. */
export function nearLng(lng, ref) {
  const d = lng - ref;
  return lng - 360 * Math.round(d / 360);
}

/** An area's bounds as { west, south, east, north }, or null when it has none (or bad ones). */
export function boundsOf(a) {
  if (!a) return null;
  const west = num(a.west), south = num(a.south), east = num(a.east), north = num(a.north);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (!(south < north) || west === east) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180 || Math.abs(south) > 90 || Math.abs(north) > 90) return null;
  return { west, south, east, north };
}

/** How many degrees of longitude a box spans, going east from its west edge (0 < w < 360). */
export function widthOf(b) {
  return b.west < b.east ? b.east - b.west : b.east + 360 - b.west;
}

/** Is the point inside the box? `pad` widens the box by that many degrees on every side. */
export function inBounds(b, lng, lat, pad = 0) {
  if (!b || !Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (lat < b.south - pad || lat > b.north + pad) return false;
  const w = widthOf(b) + 2 * pad;
  if (w >= 360) return true;
  // How far east of the (padded) west edge the point lies, going round the planet eastwards.
  const east = (((lng - (b.west - pad)) % 360) + 360) % 360;
  return east <= w;
}

// Words for an area code no row answers for: "old_town" reads "Old Town". Never actively
// wrong, and only seen for a place written before its area was a row.
const words = (code) => String(code || "").split(/[_-]+/).filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/**
 * Read a trip's areas once; ask the answer as often as needed.
 *   label(code)        the words for a place's area: "Alfama, Lisbon", "Lisbon", or "" for none
 *   regions            the top-level areas, in the trip's order: { id, name, bounds|null }
 *   regionOf(place)    the region a place belongs to: through its area, else the smallest
 *                      region whose bounds hold its coordinates; null when neither answers
 *   inRegion(r, place) is this place one of that region's (the same rule, for one region)
 */
export function readAreas(areas) {
  const rows = (Array.isArray(areas) ? areas : []).filter((a) => a && a.id != null);
  const byId = new Map(rows.map((a) => [String(a.id), a]));
  const top = (a) => {
    const p = a && a.parent != null && a.parent !== "" ? byId.get(String(a.parent)) : null;
    return p || a;
  };
  const order = (a, b) => (num(a.sort) || 0) - (num(b.sort) || 0) || String(a.name || "").localeCompare(String(b.name || ""));
  const regions = rows.filter((a) => top(a) === a).sort(order)
    .map((a) => ({ id: String(a.id), name: String(a.name || words(a.id)), bounds: boundsOf(a) }));
  const regionById = new Map(regions.map((r) => [r.id, r]));
  // Smallest box first: a region drawn inside another (a valley inside its province) wins.
  const size = (b) => widthOf(b) * (b.north - b.south);
  const bounded = regions.filter((r) => r.bounds).sort((a, b) => size(a.bounds) - size(b.bounds));

  function label(code) {
    const key = code == null ? "" : String(code);
    if (!key) return "";
    const a = byId.get(key);
    if (!a) return words(key);
    const name = String(a.name || words(a.id));
    const t = top(a);
    return t === a ? name : `${name}, ${String(t.name || words(t.id))}`;
  }

  function regionOf(place) {
    if (!place) return null;
    const a = place.area != null ? byId.get(String(place.area)) : null;
    if (a) return regionById.get(String(top(a).id)) || null;
    const lng = num(place.lng), lat = num(place.lat);
    for (const r of bounded) if (inBounds(r.bounds, lng, lat)) return r;
    return null;
  }

  const inRegion = (r, place) => {
    const mine = regionOf(place);
    return !!(r && mine && mine.id === r.id);
  };

  return { label, regions, bounded, regionOf, inRegion };
}

/**
 * Is a camera centre anywhere near this trip? Near means within `pad` degrees of one of its
 * bounded regions or of one of its places. A trip with neither has nowhere to be far from,
 * and every camera is as good as another.
 */
export function nearTrip(read, places, lng, lat, pad = 3) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  const pts = (places || []).filter((p) => Number.isFinite(num(p.lng)) && Number.isFinite(num(p.lat)));
  if (!read.bounded.length && !pts.length) return true;
  for (const r of read.bounded) if (inBounds(r.bounds, lng, lat, pad)) return true;
  for (const p of pts) {
    if (Math.abs(num(p.lat) - lat) <= pad && Math.abs(nearLng(num(p.lng), lng) - lng) <= pad) return true;
  }
  return false;
}

/**
 * The box that holds a set of [lng, lat] points and boxes, written so that it never takes
 * the long way round the planet: points either side of the 180° line give a box across it.
 * Returns { west, south, east, north, width } or null: west is greater than east when the box
 * crosses the line, and `width` is its degrees of longitude (0 for a single meridian, where
 * west equals east).
 */
export function boxAround(points, boxes = []) {
  const lats = [], lngs = [];
  for (const p of points || []) {
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) { lngs.push([p[0], p[0]]); lats.push(p[1]); }
  }
  for (const b of boxes || []) {
    if (!b) continue;
    lngs.push([b.west, b.west + widthOf(b)]);
    lats.push(b.south, b.north);
  }
  if (!lngs.length) return null;
  // Lay every span on one number line, each written nearest the first, then find the widest
  // empty gap going round: the box is everything outside that gap.
  const spans = lngs.map(([w, e]) => {
    const nw = (((w + 180) % 360) + 360) % 360 - 180;
    return [nw, nw + (e - w)];
  }).sort((a, b) => a[0] - b[0]);
  let west = spans[0][0], reach = spans[0][1];
  let gap = -1, gapEnd = 0;
  const merged = [];
  for (const [w, e] of spans) {
    if (w > reach) { merged.push([west, reach]); west = w; reach = e; } else reach = Math.max(reach, e);
  }
  merged.push([west, reach]);
  // Gaps between merged spans, and the one that wraps from the last back round to the first.
  let start = merged[0][0], width = 360;
  for (let i = 0; i < merged.length; i++) {
    const next = i + 1 < merged.length ? merged[i + 1][0] : merged[0][0] + 360;
    const g = next - merged[i][1];
    if (g > gap) { gap = g; gapEnd = next; }
  }
  if (gap > 0) { start = gapEnd; width = 360 - gap; }
  const south = Math.min(...lats), north = Math.max(...lats);
  if (width >= 360) return { west: -180, south, east: 180, north, width: 360 };
  const w = (((start + 180) % 360) + 360) % 360 - 180;
  let e = w + width;
  if (e > 180) e -= 360;
  return { west: w, south, east: e, north, width };
}
