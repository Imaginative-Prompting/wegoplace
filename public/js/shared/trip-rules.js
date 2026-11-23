// The checks a trip's rows are held to: one copy for the app's forms and the Worker.
//
// PURE, AND SHARED. No DOM, no storage, no network. The Worker refuses with these, and a form
// can use the same function to say what's wrong before anything is sent. Each check answers
// { ok: true, … } or { ok: false, error }, where `error` is a sentence for whoever wrote the
// row (a person, or an AI through the tools) that says what was wrong and what is allowed.
//
// What lives elsewhere: a place's kind and subkind are `place-kinds.js`, its hours `hours.js`,
// the numbers `limits.js`.

import { PLACE_TAGS_MAX, ROW_ID_MAX, TAG_MAX } from "./limits.js";

// ── ids ────────────────────────────────────────────────────────────────────────────────────
// An area's, a place's and an event's id is unique within its trip. Whoever writes a NEW row
// may choose it; rows from before this rule keep the ids they have and are written by them.
// Underscores too: the old app makes ids like ev_<uuid>, and a change it made with no signal a
// minute before the cutover arrives with one.
const NEW_ID = new RegExp(`^[a-z0-9_-]{1,${ROW_ID_MAX}}$`);

/** An id for a new row. */
export function readNewId(id) {
  if (typeof id === "string" && NEW_ID.test(id)) return { ok: true, id };
  return {
    ok: false,
    error: `${show(id)} can't be an id. An id is lowercase letters, digits, hyphens and underscores, at most ${ROW_ID_MAX} characters ("stay-lisbon"), and only has to be unique in this trip.`,
  };
}

// ── days ───────────────────────────────────────────────────────────────────────────────────
/** A calendar day that exists, written YYYY-MM-DD. */
export function isDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The calendar day, YYYY-MM-DD, that a moment falls on in a time zone. */
export function dayIn(epochSeconds, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(epochSeconds * 1000));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Whether a day is one of the trip's. A trip without dates has no days. `what` names the thing
 * being checked, for the sentence ("This event starts").
 */
export function onTripDay(day, trip, what) {
  if (!trip.starts_on || !trip.ends_on) {
    return { ok: false, error: "The trip has no dates yet, so nothing can be put on a day of it. Set the trip's dates first." };
  }
  if (day < trip.starts_on || day > trip.ends_on) {
    return { ok: false, error: `${what} on ${day}, which isn't a day of the trip. The trip runs from ${trip.starts_on} to ${trip.ends_on}.` };
  }
  return { ok: true, day };
}

// ── an area's bounds ───────────────────────────────────────────────────────────────────────
// A box in degrees. West and east are the box's two edges going east from west: a region
// that crosses the 180° line (west 177, east -178) has west greater than east, and that is
// a box like any other. South is below north.

/** The four edges, all or none. Answers { ok, bounds } with bounds null for none. */
export function readBounds({ west, south, east, north }) {
  const given = [west, south, east, north].filter((v) => v !== undefined && v !== null);
  if (!given.length) return { ok: true, bounds: null };
  const why = " Bounds are west, south, east and north in degrees, all four or none: west and east from -180 to 180 (west is greater than east only for a box that crosses the 180° line), south below north, both from -90 to 90.";
  if (given.length !== 4 || ![west, south, east, north].every((v) => typeof v === "number" && Number.isFinite(v))) {
    return { ok: false, error: `The bounds need all four numbers or none.${why}` };
  }
  if (west < -180 || west > 180 || east < -180 || east > 180) return { ok: false, error: `West and east must each be from -180 to 180.${why}` };
  if (west === east) return { ok: false, error: `West and east are the same, so the box has no width.${why}` };
  if (south < -90 || north > 90 || south >= north) return { ok: false, error: `South must be below north, both from -90 to 90.${why}` };
  return { ok: true, bounds: { west, south, east, north } };
}

/** Whether a point lies inside a box (edges included), the 180° line handled. */
export function inBounds(lat, lng, b) {
  if (lat < b.south || lat > b.north) return false;
  return b.west <= b.east ? lng >= b.west && lng <= b.east : lng >= b.west || lng <= b.east;
}

// ── a place's coordinates ──────────────────────────────────────────────────────────────────

/** Both or neither; real numbers in range; never 0,0. Answers { ok, lat, lng } (both null for none). */
export function readCoordinates(lat, lng) {
  const none = (v) => v === undefined || v === null || v === "";
  if (none(lat) && none(lng)) return { ok: true, lat: null, lng: null };
  const why = " Send both lat and lng, from a map source or a geocoder for this exact place, or neither: a place without coordinates shows as not confirmed.";
  if (none(lat) || none(lng)) return { ok: false, error: `Only one of lat and lng was sent.${why}` };
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)
    || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, error: `lat must be a number from -90 to 90 and lng from -180 to 180.${why}` };
  }
  if (lat === 0 && lng === 0) return { ok: false, error: `0,0 is in the sea off Africa, not a place.${why}` };
  return { ok: true, lat, lng };
}

/** Meters between two points (haversine on a sphere of the Earth's mean radius). */
export function metersBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ── a place's tags ─────────────────────────────────────────────────────────────────────────
const TAG = new RegExp(`^[a-z0-9]+(?:-[a-z0-9]+)*$`);

/** Up to six, each lowercase words joined by hyphens. Duplicates are dropped, order kept. */
export function readTags(tags) {
  const why = ` Tags are at most ${PLACE_TAGS_MAX}, each lowercase words joined by hyphens ("cash-only", "open-late"), at most ${TAG_MAX} characters.`;
  if (!Array.isArray(tags)) return { ok: false, error: `Tags must be a list.${why}` };
  const out = [];
  for (const t of tags) {
    if (typeof t !== "string" || t.length > TAG_MAX || !TAG.test(t)) return { ok: false, error: `${show(t)} can't be a tag.${why}` };
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > PLACE_TAGS_MAX) return { ok: false, error: `${out.length} tags is too many.${why} How well a fact was checked is never a tag: that is confidence.` };
  return { ok: true, tags: out };
}

// What was written, as it was written: a trailing space or a capital may be the whole mistake.
const show = (v) => (typeof v === "string" && v !== "" ? JSON.stringify(v.slice(0, 70)) : "Nothing");

// ── packing items ─────────────────────────────────────────────────────────────────────────
// What a packing item's write takes (src/api/ignored.js names any other field in the answer, and
// refuses `done` and `section`, whose meaning moved; public/js/store.js sends exactly these).
// Whether a thing is packed is a tick of its own (PUT …/packing/ticks): the old app sent `done`.
export const PACKING_ITEM_FIELDS = ["id", "owner", "label", "category", "note", "qty", "sort", "bags"];
