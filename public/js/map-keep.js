// map-keep.js — THE TRIP'S MAP, KEPT ON THE PHONE WITHOUT ANYONE ASKING FOR IT.
//
// Everything a trip needs with no signal is on the phone after its first open with signal.
// There is no "save for offline" button anywhere, because a button is something each person
// in a group can forget to press. The plans, the places and the purchases come with the
// trip's snapshot (store.js). This file is the map's half: the trip's archive
// (GET /api/trips/<id>/tiles) and the glyph ranges its labels are drawn with, fetched in the
// background once the trip's own data is in, whether or not the map screen is ever opened.
//
// ONE KEEP, TWO CALLERS. The shell calls keepMap() when a trip's data has arrived (index.html);
// the map screen calls it when its first view has settled, and again when a person answers
// its note (map.js). A call while another is under way for the same map joins it, so the
// same map is never fetched twice.
//
// WHAT IS KEPT WITHOUT ASKING, AND WHAT ASKS FIRST
//   - A map the server cut fits what a phone keeps without asking, by construction
//     (MAX_STASH_BYTES): kept.
//   - A map somebody uploaded can be bigger. Over the budget it is kept only on the person's
//     word for that very map: the map screen's note asks ("asks").
//   - With the browser's own "save data" setting on, the person has already said what they
//     want from a connection: the same note asks ("asks").
//   - A phone short of room keeps the trip and not the map, and says so in words ("no-room").
//     Filling the origin's quota starts evicting IndexedDB, which is where the trip lives.
//     The trip always wins. Nothing here ever removes another trip's map to make room.
//
// THE LABELS. A map draws its names from glyph files of 256 characters each
// (/tiles/fonts/<font>/<range>.pbf), fetched as the labels need them: no use once the signal
// is gone. A cut map lists the ranges its labels use (the snapshot's tiles.glyphs); an
// uploaded one lists none, and gets the Latin ranges (LATIN). Each range is fetched once for
// each font the style names, and stored here, in the cache the service worker reads map
// furniture from (sw.js, tiles()), under the address it would use. A range already there is
// not asked for again.
//
// No store, no DOM: what the trip says about its map is handed in, and what happened is
// handed back and told to whoever listens (onKeep). The two sentences a person may read
// about it are here, so the shell and the map screen say the same thing.

import { adoptOldArchive } from "./trip-adopt.js";
import { tripKey } from "./trip-here.js";

/** Where each trip's archive is kept: its own cache, each archive at its trip's address. */
export const TILE_CACHE = "wgp-tiles-v1";
/** The service worker's cache of map furniture (sw.js, TILES): the glyph ranges. */
export const GLYPH_CACHE = "wegoplace-tiles-v1";
/** The kept copy says which map it is in a header of its own. */
export const VERSION_HEADER = "X-Map-Version";
export const GLYPHS_URL = "/tiles/fonts/{fontstack}/{range}.pbf";

// Above this a map is read by range from the network instead of being kept, unless the
// person says to keep it. 48 MB is about what a phone holds happily beside the app's own
// storage, and it is the number a cut is made to stay under.
export const MAX_STASH_BYTES = 48 * 1024 * 1024;
// What the service worker will keep of one glyph file (sw.js, TILE_ASSET_MAX).
const GLYPH_MAX = 4 * 1024 * 1024;

/** The glyph ranges kept for a map that lists none: Latin, with its accents. */
export const LATIN = ["0-255", "256-511"];

// Per trip, in localStorage: which map's note was put away, which big map the person said to
// keep, which they said not to, and which map's lines the shell has already said.
export const SAID_KEY = "wgp.map.said";
// A choice about one trip, stored once per trip: see TRIP_KEYS in trip-here.js.
const here = (key, tripId) => tripKey(key, tripId);

export const archiveUrl = (tripId) => `/api/trips/${encodeURIComponent(tripId || "")}/tiles`;
// What is read over the network names the version, so that no cache between here and the
// server can hand back the map before it. The kept copy sits under the bare address.
export const archiveAt = (tripId, version) =>
  (version ? `${archiveUrl(tripId)}?v=${encodeURIComponent(version)}` : archiveUrl(tripId));

/**
 * What the trip says about its map (docs/API.md, "The trip's map"), read the same way
 * everywhere. With no answer yet (a phone that has never reached the trip) there is no map.
 *   ready    there is an archive to read now (a failed cut keeps the last map)
 *   version  changes with each new map
 *   glyphs   the ranges its labels use; none listed (an uploaded map) is []
 */
export function mapStateOf(t) {
  if (!t || typeof t !== "object") return { state: "none", ready: false, version: "", bytes: 0, source: "", note: "", glyphs: [] };
  const state = String(t.state || "none");
  return {
    state,
    ready: t.ready === undefined ? state === "ready" : !!t.ready,
    version: t.version == null ? "" : String(t.version),
    bytes: Number(t.bytes) || 0,
    source: String(t.source || ""),
    note: typeof t.note === "string" ? t.note.trim() : "",
    glyphs: Array.isArray(t.glyphs) ? t.glyphs.map(String).filter((g) => /^\d+-\d+$/.test(g)) : [],
  };
}

/** Said once, quietly, when a trip's map starts coming down in the background. */
export const KEEPING_WORDS = "Keeping this trip's map on your phone";
/** Said when the phone has no room for the map. With no archive the map still draws the trip's places, on plain ground. */
export const roomWords = (bytes) => {
  const size = bytes > 0 ? ` (${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB)` : "";
  return `This phone is short of room. Your trip is kept; its map${size} isn't, so with no signal the map shows your places without the streets.`;
};

/** What this phone has been told, or has answered, about this trip's map. */
export function said(tripId) {
  try { const v = JSON.parse(localStorage.getItem(here(SAID_KEY, tripId)) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
export function say(tripId, patch) {
  try { localStorage.setItem(here(SAID_KEY, tripId), JSON.stringify({ ...said(tripId), ...patch })); } catch { /* private mode: said again next time */ }
}

/** The archive's copy on the phone, when it keeps one: { blob, version }. */
export async function cachedArchive(tripId) {
  if (typeof caches === "undefined" || !tripId) return null;
  try {
    const url = archiveUrl(tripId);
    // A phone from before a map belonged to a trip kept its one archive at another address:
    // it is this trip's, when this is the trip that phone had (trip-adopt.js).
    await adoptOldArchive(TILE_CACHE, tripId, url).catch(() => false);
    const c = await caches.open(TILE_CACHE);
    const r = await c.match(url);
    if (!r || !r.ok) return null;
    const b = await r.blob();
    return b && b.size > 1024 ? { blob: b, version: r.headers.get(VERSION_HEADER) } : null;
  } catch { return null; }
}

// A copy kept before versions were written down has none: it is the trip's map now when it
// is the same size to the byte, and is then marked with the version rather than fetched again.
export const isCurrent = (kept, m) => !!kept && (kept.version === m.version || (!kept.version && m.bytes > 0 && kept.blob.size === m.bytes));

const putArchive = async (tripId, blob, version) => (await caches.open(TILE_CACHE)).put(archiveUrl(tripId), new Response(blob, {
  status: 200,
  headers: { "Content-Type": "application/octet-stream", "Content-Length": String(blob.size), [VERSION_HEADER]: version },
}));

// ── the style's layers, and the fonts they name ───────────────────────────────────────────
// The basemap's layers as the map draws them (map.js, buildStyle()), here so that the fonts
// kept are the fonts drawn, by construction.
//
// Points of interest are dropped: they are the one thing on the basemap that competes with
// the trip's own pins. Highway shields go with them: the shield IS the icon, and the number
// alone floating on a road reads as a rendering fault.
//
// Icons are taken off generically rather than by name. The basemap's layers ask for icons
// out of a sprite sheet this app does not ship, and with no sprite in the style MapLibre
// answers each with a warning, per tile, forever: console noise is where real errors hide.
// Any layer that asks for an icon loses its icon-* properties, and a layer that had nothing
// but an icon is dropped. A flavor that adds another sprite name is silent too, and every
// label survives.
function deIcon(l) {
  const lay = l.layout;
  if (!lay || !lay["icon-image"]) return l;
  const layout = {};
  for (const k of Object.keys(lay)) if (!k.startsWith("icon-")) layout[k] = lay[k];
  if (!layout["text-field"]) return null;      // an icon-only layer has nothing left to draw
  return { ...l, layout };
}
const BASEMAP_FLAVOR = {
  dark: {
    background: "#000000", earth: "#0d0d0c", water: "#131517",
    park_a: "#10140f", park_b: "#10140f", wood_a: "#10140f", wood_b: "#10140f",
    scrub_a: "#10140f", scrub_b: "#10140f",
    hospital: "#111110", industrial: "#111110", school: "#111110", pedestrian: "#121210",
    aerodrome: "#111110", zoo: "#10140f", military: "#111110",
    sand: "#131311", beach: "#151512", glacier: "#171715",
    buildings: "#151513", runway: "#1d1c19", pier: "#1d1c19",
    other: "#1d1c19", minor_service: "#1d1c19", minor_a: "#23221f", minor_b: "#23221f",
    link: "#272622", major: "#2c2b27", highway: "#35342f",
    bridges_other: "#1d1c19", bridges_minor: "#23221f", bridges_major: "#2c2b27", bridges_highway: "#35342f",
    tunnel_other: "#171715", tunnel_minor: "#1a1917", tunnel_major: "#21201d", tunnel_highway: "#282723",
    minor_service_casing: "#0d0d0c", minor_casing: "#0d0d0c", link_casing: "#0d0d0c",
    major_casing_early: "#0d0d0c", major_casing_late: "#0d0d0c",
    highway_casing_early: "#0d0d0c", highway_casing_late: "#0d0d0c",
    bridges_other_casing: "#0d0d0c", bridges_minor_casing: "#0d0d0c", bridges_link_casing: "#0d0d0c",
    bridges_major_casing: "#0d0d0c", bridges_highway_casing: "#0d0d0c",
    tunnel_other_casing: "#0d0d0c", tunnel_minor_casing: "#0d0d0c", tunnel_link_casing: "#0d0d0c",
    tunnel_major_casing: "#0d0d0c", tunnel_highway_casing: "#0d0d0c",
    railway: "#23221f", boundaries: "#35342f",
    city_label: "#a7a49c", city_label_halo: "#0d0d0c",
    subplace_label: "#75726a", subplace_label_halo: "#0d0d0c",
    roads_label_major: "#75726a", roads_label_major_halo: "#0d0d0c",
    roads_label_minor: "#56544d", roads_label_minor_halo: "#0d0d0c",
    ocean_label: "#75726a", state_label: "#56544d", state_label_halo: "#0d0d0c",
    country_label: "#75726a", address_label: "#56544d", address_label_halo: "#0d0d0c",
    landcover: null,
  },
  light: {
    background: "#fdfdfc", earth: "#f2f1ed", water: "#e3e8ec",
    park_a: "#e8eee6", park_b: "#e8eee6", wood_a: "#e8eee6", wood_b: "#e8eee6",
    scrub_a: "#e8eee6", scrub_b: "#e8eee6",
    hospital: "#ecebe6", industrial: "#ecebe6", school: "#ecebe6", pedestrian: "#eeede8",
    aerodrome: "#ecebe6", zoo: "#e8eee6", military: "#ecebe6",
    sand: "#eeece4", beach: "#eeece4", glacier: "#f6f5f2",
    buildings: "#e7e5e0", runway: "#e2e0da", pier: "#e2e0da",
    other: "#faf9f6", minor_service: "#faf9f6", minor_a: "#ffffff", minor_b: "#ffffff",
    link: "#ffffff", major: "#ffffff", highway: "#fdfdfc",
    bridges_other: "#faf9f6", bridges_minor: "#ffffff", bridges_major: "#ffffff", bridges_highway: "#fdfdfc",
    tunnel_other: "#ecebe6", tunnel_minor: "#e7e5e0", tunnel_major: "#e7e5e0", tunnel_highway: "#e7e5e0",
    minor_service_casing: "#dcdad3", minor_casing: "#dcdad3", link_casing: "#dcdad3",
    major_casing_early: "#dcdad3", major_casing_late: "#dcdad3",
    highway_casing_early: "#dcdad3", highway_casing_late: "#dcdad3",
    bridges_other_casing: "#dcdad3", bridges_minor_casing: "#dcdad3", bridges_link_casing: "#dcdad3",
    bridges_major_casing: "#dcdad3", bridges_highway_casing: "#dcdad3",
    tunnel_other_casing: "#dcdad3", tunnel_minor_casing: "#dcdad3", tunnel_link_casing: "#dcdad3",
    tunnel_major_casing: "#dcdad3", tunnel_highway_casing: "#dcdad3",
    railway: "#d3d1ca", boundaries: "#c8c5bc",
    city_label: "#57544d", city_label_halo: "#f2f1ed",
    subplace_label: "#7c7970", subplace_label_halo: "#f2f1ed",
    roads_label_major: "#7c7970", roads_label_major_halo: "#f2f1ed",
    roads_label_minor: "#99968d", roads_label_minor_halo: "#f2f1ed",
    ocean_label: "#7c7970", state_label: "#99968d", state_label_halo: "#f2f1ed",
    country_label: "#7c7970", address_label: "#99968d", address_label_halo: "#f2f1ed",
    landcover: null,
  },
};

/** bm: the basemaps module; flavor: "light" or "dark". */
export function styleLayers(bm, flavor) {
  const f = flavor === "dark" ? "dark" : "light";
  const palette = { ...bm.namedFlavor(f), ...BASEMAP_FLAVOR[f] };
  return bm.layers("proto", palette, { lang: "en" })
    .filter((l) => l["source-layer"] !== "pois" && l.id !== "address_label" && l.id !== "roads_shields")
    .map(deIcon)
    .filter(Boolean);
}

/**
 * Every font those layers can draw with, each as the name MapLibre asks for it by. A layer
 * names its font outright (`"text-font": ["Noto Sans Regular"]`), by a rule
 * (`["case", …, ["literal", ["Noto Sans Medium"]], …]`), or for part of a name inside its
 * text (`["format", …, { "text-font": ["literal", ["Noto Sans Devanagari Regular v1"]] }]`:
 * a script the main font doesn't hold). All three are read: under any "text-font", every
 * list made only of words is a font stack.
 */
export function fontStacks(layers) {
  const stacks = new Set();
  // direct: this list is what a "text-font" or a ["literal", …] holds, so words in it are fonts
  // (anywhere else a list of words is an expression: ["get", "min_zoom"]).
  const stacksIn = (v, direct) => {
    if (!Array.isArray(v) || !v.length) return;
    if (direct && v.every((x) => typeof x === "string")) { stacks.add(v.join(",")); return; }
    if (v[0] === "literal") { stacksIn(v[1], true); return; }
    for (const x of v) stacksIn(x, false);
  };
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) { if (k === "text-font") stacksIn(x, true); else walk(x); }
  };
  for (const l of layers) walk(l.layout);
  return [...stacks].sort();
}

/** The address MapLibre asks a glyph range at, and the key the service worker keeps it under. */
export function glyphAddress(stack, range, origin = location.origin) {
  const url = new URL(GLYPHS_URL.replace("{fontstack}", stack).replace("{range}", range), origin);
  return { url: url.href, key: url.origin + url.pathname };
}

let stacksOnce = null;
const styleStacks = () => (stacksOnce ||= import("/vendor/basemaps/basemaps.mjs")
  .then((bm) => fontStacks(styleLayers(bm, "light")))
  .catch((e) => { stacksOnce = null; throw e; }));

// A range the server doesn't have (it answered, and not with a glyph file) is not asked for
// again in this visit.
const noSuchGlyph = new Set();

/**
 * The map's label glyphs, onto the phone: { had, fetched, owed }. `owed` are ranges that
 * could not be fetched this time (no signal, a failed request); the next call asks again.
 */
export async function keepGlyphs(m) {
  const tally = { had: 0, fetched: 0, owed: 0 };
  if (typeof caches === "undefined") return tally;
  const ranges = m.glyphs.length ? m.glyphs : LATIN;
  let stacks;
  try { stacks = await styleStacks(); } catch { tally.owed = ranges.length; return tally; }
  const cache = await caches.open(GLYPH_CACHE);
  for (const stack of stacks) {
    for (const range of ranges) {
      const { url, key } = glyphAddress(stack, range);
      if (noSuchGlyph.has(key)) continue;
      if (await cache.match(key)) { tally.had += 1; continue; }
      if (!navigator.onLine) { tally.owed += 1; continue; }
      try {
        const res = await fetch(url);
        // The same guard the service worker keeps map furniture by: exactly 200, not a
        // redirect to a sign-in page, and claiming to be what a glyph file is. A hotel's
        // captive portal answers everything with a page; kept as a glyph file it would
        // blank every name on the map for good.
        const type = (res.headers.get("Content-Type") || "").toLowerCase();
        if (res.status !== 200 || res.redirected || !/protobuf|octet-stream/.test(type)) {
          if (res.status === 404) noSuchGlyph.add(key); else tally.owed += 1;
          continue;
        }
        const body = await res.blob();
        if (body.size > GLYPH_MAX) { noSuchGlyph.add(key); continue; }
        await cache.put(key, new Response(body, { status: 200, headers: res.headers }));
        tally.fetched += 1;
      } catch { tally.owed += 1; }
    }
  }
  return tally;
}

// ── the keep ──────────────────────────────────────────────────────────────────────────────
const flights = new Map();    // "<trip>|<version>" → the keep under way
const failures = new Map();   // "<trip>|<version>" → how many times it failed in this visit
const lastOf = new Map();     // trip → what the last keep came to
const listeners = new Set();

/** Hear what a keep is doing: fn({ tripId, version, bytes, archive, … }). Answers the way to stop hearing. */
export function onKeep(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function tell(e) {
  for (const fn of listeners) { try { fn(e); } catch (err) { console.error("[map-keep] a listener threw", err); } }
}

/** What the last keep of this trip's map came to in this visit, or null. */
export const keepState = (tripId) => lastOf.get(tripId) || null;

/**
 * Keep this trip's map on the phone. `tiles` answers what the trip says about its map now
 * (store.tiles): asked at the start, and again when the archive has come down, because a
 * map can be cut again while the one before it is on its way. `again`: the person asked
 * (the note's "Keep it"), so a map that failed twice in this visit is tried once more.
 *
 * Answers, and tells every listener, { tripId, version, bytes, archive, glyphs }:
 *   archive  "kept"      fetched and stored now
 *            "current"   the phone already had this very map
 *            "asks"      over the budget, or "save data" is on: only on the person's word
 *            "no-room"   the phone is short of room: the trip is kept, the map is not
 *            "moved"     the trip's map changed while this one came down: call again
 *            "failed"    the request failed; a map is tried twice a visit (so are owed glyphs)
 *            "none"      the trip has no map to keep, or there is no signal or no cache
 *   glyphs   { had, fetched, owed } when the archive is on the phone
 * Before the archive's bytes are asked for, listeners hear { archive: "fetching" }.
 */
export function keepMap({ tripId, tiles, again = false }) {
  const m = mapStateOf(tiles());
  const nothing = { tripId, version: m.version, bytes: m.bytes, archive: "none", glyphs: null };
  if (!tripId || !m.ready || typeof caches === "undefined" || !navigator.onLine) return Promise.resolve(nothing);
  const key = `${tripId}|${m.version}`;
  if (flights.has(key)) return flights.get(key);
  if (again) failures.delete(key);
  if ((failures.get(key) || 0) >= 2) return Promise.resolve({ ...nothing, archive: "failed" });
  const flight = keepNow(tripId, m, tiles)
    .catch(() => ({ ...nothing, archive: "failed" }))    // offline mid-way, quota, a cache that would not open
    .then((came) => {
      // Glyph ranges still owed count as a try that failed: asked again, and not forever.
      if (came.archive === "failed" || (came.glyphs && came.glyphs.owed)) failures.set(key, (failures.get(key) || 0) + 1);
      else failures.delete(key);
      flights.delete(key);
      lastOf.set(tripId, came);
      tell(came);
      return came;
    });
  flights.set(key, flight);
  return flight;
}

async function keepNow(tripId, m, tiles) {
  let size = m.bytes;
  const came = (archive, glyphs = null) => ({ tripId, version: m.version, bytes: size, archive, glyphs });

  const kept = await cachedArchive(tripId);
  // The copy on the phone is the map the trip has now: only its label glyphs may be owed.
  if (isCurrent(kept, m)) {
    if (kept.version !== m.version) await putArchive(tripId, kept.blob, m.version);
    return came("current", await keepGlyphs(m));
  }

  if (!size) {
    const head = await fetch(archiveAt(tripId, m.version), { method: "HEAD" });
    if (!head.ok) return came("failed");
    size = Number(head.headers.get("Content-Length") || 0);
  }
  if (!size) return came("failed");

  const word = said(tripId).keep === m.version;
  if (size > MAX_STASH_BYTES && !word) return came("asks");
  if (navigator.connection && navigator.connection.saveData && !word) return came("asks");
  if (navigator.storage && navigator.storage.estimate) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < size * 2) return came("no-room");
  }

  tell(came("fetching"));
  const res = await fetch(archiveAt(tripId, m.version));
  if (!res.ok || res.status !== 200) return came("failed");
  const blob = await res.blob();
  if (mapStateOf(tiles()).version !== m.version) return came("moved");      // cut again while this came down
  await putArchive(tripId, blob, m.version);
  return came("kept", await keepGlyphs(m));
}
