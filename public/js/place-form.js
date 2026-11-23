// place-form.js: a place added or changed by hand, the rules with no DOM and no store.
//
// The sheet (place-editor.js) is the form on screen. This file says what its values mean:
// what the server will take, the id a new place gets, what a change writes, and what can be
// read out of a map link's own text. Node checks it (scripts/place_form_check.mjs).
//
// The server holds every row to the same rules (docs/API.md, Places); this file words the
// ones a person can break in a form as sentences for under the field.

import { PLACE_KINDS, SUBKINDS, subkind as subkindEntry, subkindsOf } from "./shared/place-kinds.js";
import { ROW_ID_MAX } from "./shared/limits.js";
import { readLink } from "./plan-form.js";
import { boundsOf, inBounds, readAreas } from "./areas.js";

export const NAME_MAX = 200;
export const ADDRESS_MAX = 500;
export const WHY_MAX = 500;

/** The seven kinds, in the list's order, with the word each is offered by. */
export const KIND_WORDS = [
  ["lodging", "Stay"], ["food", "Food"], ["drink", "Drink"], ["sight", "Sight"],
  ["activity", "Activity"], ["transit", "Transit"], ["practical", "Practical"],
];

/** The subkinds offered for a kind: its own, in the list's order, as { id, label }. */
export function subkindsFor(kind) {
  return SUBKINDS.filter((s) => s.kind === kind).map((s) => ({ id: s.id, label: s.label }));
}

/** The subkind a kind starts on, so that choosing the kind alone is enough. */
export function firstSubkind(kind) {
  return subkindsOf(kind)[0] || "";
}

const settle = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

/**
 * The id of a new place: its name as lowercase letters, digits and hyphens, then a short
 * tail so two places of one name (or one name typed on two phones with no signal) stay two
 * rows. `tail` is the caller's randomness: six of [a-z0-9].
 */
export function placeId(name, tail) {
  const end = String(tail || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "x";
  const slug = settle(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const room = ROW_ID_MAX - end.length - 1;
  const head = (slug || "place").slice(0, room).replace(/-+$/, "") || "place";
  return `${head}-${end}`;
}

const inRange = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/**
 * The form's values as a place's fields.
 *   form: { name, kind, subkind, area, address, why, link, lat, lng }  (lat/lng: numbers, or null for no pin)
 *   areas: the trip's area rows, for the one rule that needs them (a pin lies in its area)
 * Answers { place } with name, kind, subkind, area (an id or null), address, why, website,
 * lat, lng, or { field, words }: which field to show the sentence under.
 */
export function readPlace(form, { areas = [] } = {}) {
  const f = form || {};
  const name = settle(f.name);
  if (!name) return { field: "name", words: "Give the place a name." };
  if (name.length > NAME_MAX) return { field: "name", words: `A name is at most ${NAME_MAX} characters; this one is ${name.length}.` };
  const kind = PLACE_KINDS.includes(f.kind) ? f.kind : "";
  if (!kind) return { field: "kind", words: "Choose what kind of place it is." };
  const sub = subkindEntry(f.subkind) ? f.subkind : firstSubkind(kind);
  const address = settle(f.address);
  if (address.length > ADDRESS_MAX) return { field: "address", words: `An address is at most ${ADDRESS_MAX} characters; this one is ${address.length}.` };
  const why = String(f.why == null ? "" : f.why).trim();
  if (why.length > WHY_MAX) return { field: "why", words: `A note here is at most ${WHY_MAX} characters; this one is ${why.length}.` };
  const link = readLink(f.link);
  if (link.words) return { field: "link", words: link.words };
  const hasLat = f.lat !== null && f.lat !== undefined && f.lat !== "";
  const hasLng = f.lng !== null && f.lng !== undefined && f.lng !== "";
  let lat = null, lng = null;
  if (hasLat || hasLng) {
    lat = Number(f.lat); lng = Number(f.lng);
    if (!hasLat || !hasLng || !inRange(lat, lng)) return { field: "pin", words: "That pin isn't a spot on the map. Put it on the map again." };
    const outside = pinOutsideArea(areas, f.area, lat, lng);
    if (outside) return { field: "pin", words: outside };
  }
  return { place: { name, kind, subkind: sub, area: f.area ? String(f.area) : null, address, why, website: link.url, lat, lng } };
}

/**
 * A pin has to lie where its place's area says the place is: inside the area's own bounds,
 * or its parent's, when either has bounds (the server's rule, src/trips/areas.js). Answers
 * null when it does, or when nothing has bounds; else the sentence for under the pin.
 *   areas: the trip's area rows
 */
export function pinOutsideArea(areas, areaId, lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined || !areaId) return null;
  const rows = Array.isArray(areas) ? areas : [];
  const area = rows.find((a) => a && String(a.id) === String(areaId));
  if (!area) return null;
  const parent = area.parent != null && area.parent !== "" ? rows.find((a) => a && String(a.id) === String(area.parent)) : null;
  const boxed = [area, parent].filter((a) => a && boundsOf(a));
  if (!boxed.length || boxed.some((a) => inBounds(boundsOf(a), Number(lng), Number(lat)))) return null;
  const name = String(boxed[0].name || boxed[0].id);
  return `That spot is outside ${name}. Move the pin, or pick the area it is in.`;
}

/**
 * The line said after a new place is saved a few meters from another of its kind (the
 * server's warning, by the two places' names). `other` is the place it is near.
 */
export function nearWords(place, other, meters) {
  const a = settle(place && place.name) || "The new place";
  const b = settle(other && other.name) || "another place";
  const m = Number.isFinite(Number(meters)) ? `${Math.round(Number(meters))} m` : "a few meters";
  return `“${a}” is ${m} from “${b}”. If they are one place, remove one of them.`;
}

/**
 * Why a place can't be removed yet, from what still points at it (store.placeUses): the plans
 * at it and the places said to be near it. "" when nothing does.
 */
export function inUseWords(place, uses) {
  const name = settle(place && place.name) || "This place";
  const list = (rows, key) => {
    const names = rows.map((r) => settle(r[key])).filter(Boolean);
    const shown = names.slice(0, 3).map((n) => `“${n.length > 40 ? `${n.slice(0, 39).trimEnd()}…` : n}”`);
    const more = rows.length - shown.length;
    return shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
  };
  const ev = (uses && uses.events) || [], near = (uses && uses.places) || [];
  if (ev.length) {
    return `“${name}” is where ${ev.length === 1 ? "a plan is" : `${ev.length} plans are`}: ${list(ev, "title")}. ` +
      `Change where ${ev.length === 1 ? "that plan is" : "those plans are"} first.`;
  }
  if (near.length) {
    return near.length === 1
      ? `${list(near, "name")} is listed as near “${name}”, so “${name}” stays.`
      : `${near.length} places are listed as near “${name}” (${list(near, "name")}), so it stays.`;
  }
  return "";
}

/**
 * What to say when the server turns a place's write down. A place is written on the phone
 * first and sent when there is signal, which can be days later; by then its area may be gone,
 * a plan may have been put at the place being removed, or the place itself may have been
 * removed on another phone. The store drops the refused write and puts the screen back as the
 * server has it; this is the sentence that goes with that. The server's own refusals are
 * written for whoever sent the request, which is also an AI app, so they name ids and fields.
 *
 * @param {{ op: { kind: string, op: string, id: string, payload?: object }, status: number, body: any }} refusal
 * @param {{ name?: string }} [known]  the place's name as this phone has it (a change or a
 *        removal doesn't carry it unless the name is what changed)
 * @returns {string|null} one sentence, or null when this isn't a place's write or the general
 *          line says it as well (a 403).
 */
export function placeRefusalWords({ op, status, body } = {}, known = {}) {
  if (!op || op.kind !== "place" || status === 403) return null;
  const b = body && typeof body === "object" ? body : {};
  const p = op.payload || {};
  let name = settle(p.name) || settle(known && known.name);
  if (name.length > 40) name = `${name.slice(0, 39).trimEnd()}…`;
  const it = name ? `“${name}”` : "That place";
  const error = typeof b.error === "string" ? b.error : "";
  const row = Array.isArray(b.rows) && b.rows[0] && typeof b.rows[0].error === "string" ? b.rows[0].error : "";
  const lost = op.op === "create" ? `${it} wasn't added` : `the change to ${name ? it : "that place"} wasn't kept`;
  const Lost = lost[0].toUpperCase() + lost.slice(1);

  if (op.op === "delete") {
    if (error === "place in use") {
      const plans = Number(b.event_count) || (Array.isArray(b.events) ? b.events.length : 0);
      if (plans) return `${plans === 1 ? "A plan is" : `${plans} plans are`} at ${name ? it : "that place"} now, so it stays.`;
      return `Another place is listed as near ${name ? it : "that place"} now, so it stays.`;
    }
    return `${it} couldn't be removed.`;
  }
  if (error === "too many places") {
    return `This trip has as many places as a trip holds${Number(b.max) ? ` (${Number(b.max)})` : ""}, so ${lost}.`;
  }
  // A change to a place that is no longer there reads to the server as a new place with
  // most of itself missing.
  if (op.op === "update" && /^A new place needs/.test(row)) return `${it} was removed on another phone.`;
  if (/^There is no area/.test(row)) return `Its area was removed on another phone, so ${lost}.`;
  if (/is outside the bounds of/.test(row)) return `The pin is outside the place's area, so ${lost}.`;
  return `${Lost}.`;
}

/** A place as the form's values (the other way). */
export function formOfPlace(p) {
  const kind = PLACE_KINDS.includes(p.kind) ? p.kind : "practical";
  const hasPin = p.lat !== null && p.lat !== undefined && p.lng !== null && p.lng !== undefined && inRange(Number(p.lat), Number(p.lng));
  return {
    name: p.name || "",
    kind,
    subkind: subkindEntry(p.subkind) ? p.subkind : firstSubkind(kind),
    area: p.area || "",
    address: p.address || "",
    why: p.why || "",
    link: p.website || "",
    lat: hasPin ? Number(p.lat) : null,
    lng: hasPin ? Number(p.lng) : null,
  };
}

/**
 * What a change writes: only the fields that differ from the place as it is, so what the
 * form does not show (hours, tags, pictures, what it is near) is never touched. A pin is
 * both numbers or both null, always together. An empty object means nothing changed.
 */
export function placeChanges(p, next) {
  const out = {};
  const same = (a, b) => (a == null ? "" : String(a)) === (b == null ? "" : String(b));
  for (const k of ["name", "kind", "subkind", "address", "why", "website"]) if (!same(p[k], next[k])) out[k] = next[k];
  if (!same(p.area, next.area)) out.area = next.area || null;
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  if (num(p.lat) !== num(next.lat) || num(p.lng) !== num(next.lng)) { out.lat = num(next.lat); out.lng = num(next.lng); }
  return out;
}

// ── a location read from a link's own text ───────────────────────────────────────────────
//
// People pass places around as links from a maps app. Some of those links carry the spot in
// their own text, and that much can be read with no request to anyone. A short link
// (maps.app.goo.gl/…) carries nothing but a code: reading it would mean asking its service,
// which this never does.

const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";
const PAIR = new RegExp(`^\\s*${NUM}\\s*[,;]\\s*${NUM}\\s*$`);

function pair(a, b) {
  const lat = Number(a), lng = Number(b);
  return inRange(lat, lng) ? { lat, lng } : null;
}

/** The short forms that carry no location in their text. */
export function isShortMapLink(text) {
  const s = String(text || "").trim();
  return /^(?:https?:\/\/)?(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|maps\.apple\/p)\b/i.test(s);
}

/**
 * The spot a map link (or a pasted pair of coordinates) names, read from its text alone:
 * { lat, lng, from } or null. `from` says which part answered, for the check.
 *   "38.7071, -9.1355"                                  coordinates as copied from a maps app
 *   geo:38.7071,-9.1355                                 a geo: address
 *   …google…/maps/place/Name/@38.70,-9.13,17z/data=…!3d38.7071!4d-9.1355   the place (!3d !4d), else the view (@)
 *   …google…/maps?q=38.7071,-9.1355   …/maps/search/?api=1&query=38.7071,-9.1355   …?ll=…
 *   maps.apple.com/?ll=38.7071,-9.1355&q=Name   maps.apple.com/place?coordinate=38.7071,-9.1355
 *   openstreetmap.org/?mlat=38.7071&mlon=-9.1355#map=17/38.7071/-9.1355
 *   bing.com/maps?cp=38.7071~-9.1355
 */
export function readMapLink(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  let m = PAIR.exec(s);
  if (m) { const p = pair(m[1], m[2]); return p ? { ...p, from: "coordinates" } : null; }
  m = new RegExp(`^geo:${NUM},${NUM}`, "i").exec(s);
  if (m) { const p = pair(m[1], m[2]); return p ? { ...p, from: "geo" } : null; }
  let u = null;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const q = u.searchParams;
  const fromParam = (name, sep = ",") => {
    const v = q.get(name);
    if (!v) return null;
    const parts = v.split(sep);
    if (parts.length < 2) return null;
    const mm = PAIR.exec(`${parts[0]},${parts[1]}`);
    return mm ? pair(mm[1], mm[2]) : null;
  };
  if (/(^|\.)google\.[a-z.]+$/.test(host) || host === "maps.google.com") {
    // The place itself, when the link names one: !3d<lat>!4d<lng> (the @ part is only the view).
    m = new RegExp(`!3d${NUM}!4d${NUM}`).exec(u.pathname + u.search);
    if (m) { const p = pair(m[1], m[2]); if (p) return { ...p, from: "google place" }; }
    for (const name of ["q", "query", "ll", "destination", "center"]) {
      const p = fromParam(name);
      if (p) return { ...p, from: `google ${name}` };
    }
    m = new RegExp(`/@${NUM},${NUM}(?:,|/|$)`).exec(u.pathname);
    if (m) { const p = pair(m[1], m[2]); if (p) return { ...p, from: "google view" }; }
    return null;
  }
  if (host === "maps.apple.com") {
    for (const name of ["coordinate", "ll", "q"]) {
      const p = fromParam(name);
      if (p) return { ...p, from: `apple ${name}` };
    }
    // A link to a view of the map names only where the map was looking.
    for (const name of ["center", "sll"]) {
      const p = fromParam(name);
      if (p) return { ...p, from: "apple view" };
    }
    return null;
  }
  if (/(^|\.)openstreetmap\.org$/.test(host) || host === "osm.org") {
    if (q.get("mlat") && q.get("mlon")) { const p = pair(q.get("mlat"), q.get("mlon")); if (p) return { ...p, from: "osm marker" }; }
    m = new RegExp(`map=\\d+(?:\\.\\d+)?/${NUM}/${NUM}`).exec(u.hash);
    if (m) { const p = pair(m[1], m[2]); if (p) return { ...p, from: "osm view" }; }
    return null;
  }
  if (/(^|\.)bing\.com$/.test(host)) {
    const p = fromParam("cp", "~");
    return p ? { ...p, from: "bing" } : null;
  }
  return null;
}

/** Did the link name a place, or only where its map was looking (a guess at best)? */
export const isViewOnly = (read) => !!read && / view$/.test(read.from);

/** A pin as words: five decimals (about a metre), the way a maps app shows it. */
export function pinWords(lat, lng) {
  return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

/**
 * Area chips for the place form: each region followed by its neighborhoods, in the trip's order.
 * When two or more offered areas share a name (for instance "Centro" under two regions), add each
 * duplicate's parent via readAreas().label(id) ("Centro, Costa Alta"), matching Places rows.
 */
export function areaChipList(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const read = readAreas(rows);
  const out = [];
  const order = (a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.name || "").localeCompare(String(b.name || ""));
  for (const r of read.regions) {
    out.push({ id: r.id, name: r.name });
    for (const a of rows.filter((x) => x.parent != null && String(x.parent) === r.id).sort(order)) {
      out.push({ id: String(a.id), name: String(a.name || a.id) });
    }
  }
  // An area whose parent is not a row of the trip is still an area a place can be in.
  for (const a of rows) if (!out.some((o) => o.id === String(a.id))) out.push({ id: String(a.id), name: String(a.name || a.id) });
  const key = (s) => String(s || "").trim().toLowerCase();
  const counts = new Map();
  for (const c of out) counts.set(key(c.name), (counts.get(key(c.name)) || 0) + 1);
  return out.map((c) => {
    if ((counts.get(key(c.name)) || 0) <= 1) return c;
    const full = read.label(c.id);
    return full && full !== c.name ? { ...c, name: full } : c;
  });
}
