// A trip's places: somewhere on the map, with a card.
//
// Under /api/trips/<trip>/ (the route table checks the caller is on the trip). Any member:
//   GET    places                    -> { places }                     every place of the trip
//   PUT    places  { places: [...] } -> { places, warnings, rev }      adds each, or changes the one with that id
//   DELETE places/<id>               -> { ok, deleted, rev }
//   DELETE places  { ids: [...] }    -> { ok, deleted, rev }
//
// A PUT is all or nothing, at most 200 rows: one row that can't be written refuses the call,
// naming each row and what was wrong (`rows`, each { index, id, error }, the error a sentence
// that says what is allowed). A new place needs `id`, `name`, `kind`, `subkind` and `why`
// (`why` may be left out or empty when a person adds it by hand in the app: "the bakery by the
// hostel" needs no reason; an AI's, through the MCP, always gives one); a
// row that changes a place sends only what changes, and what it leaves out stays as it is.
// That is how an old row keeps its tags until someone rewrites them (model §16).
//
// What holds (model §5, §16; docs/guides/places.md says the same to an AI):
//   * kind and subkind from the one list (public/js/shared/place-kinds.js), checked apart;
//   * hours in the one format (public/js/shared/hours.js), stored as its canonical spelling;
//   * lat and lng both or neither, never 0,0, and inside the bounds of the place's area or of
//     that area's parent when either has bounds (src/trips/areas.js);
//   * rating and rating_count together; price_level 1 to 4; confidence high, medium or low;
//     at most six tags, lowercase with hyphens (public/js/shared/trip-rules.js);
//   * `area` and `near_anchor` name rows of this trip;
//   * `checkout` (the steps for leaving) only on lodging.
// A new place within 25 m of one of the same kind is written, and `warnings` names the other:
// it may be the same place under two ids.
//
// No filtering on read. store.js holds every place in IndexedDB anyway: "pharmacy near me"
// has to run against an array already on the phone, with or without signal.
//
// Removing a place: refused while events, or other places' `near_anchor`, point at it (the
// answer names them); a purchase that pointed at it floats, keeping its money.

import { json, readJson } from "./json.js";
import { err, nowSec } from "./trip.js";
import { REV, write } from "../trips/rev.js";
import { outsideItsArea } from "../trips/areas.js";
import { goneSteps } from "../trips/pictures.js";
import { DUPLICATE_METERS, PLACES_MAX, ROWS_PER_WRITE_MAX } from "../../public/js/shared/limits.js";
import { readPlaceKind } from "../../public/js/shared/place-kinds.js";
import { readHours } from "../../public/js/shared/hours.js";
import { metersBetween, readCoordinates, readNewId, readTags } from "../../public/js/shared/trip-rules.js";

const COLS =
  "id, trip_id, name, name_local, kind, subkind, area, address, address_note, lat, lng, " +
  "gmaps_place_id, rating, rating_count, price_level, hours, phone, website, why, notes, " +
  "tags, near_anchor, walk_minutes, confidence, source, is_anchor, verified_at, " +
  "image_url, image_credit, image_license, image_source, elevation_m, checkout, rev";

// What a PUT may write, and the column each lands in. The pictures' columns are landing 4's
// (a picture arrives by its own route); gmaps_place_id and verified_at aren't anyone's to set.
export const WRITABLE = ["name", "name_local", "kind", "subkind", "area", "address", "address_note", "lat", "lng",
  "rating", "rating_count", "price_level", "hours", "phone", "website", "why", "notes", "tags", "near_anchor",
  "walk_minutes", "confidence", "source", "is_anchor", "elevation_m", "checkout"];

const parseTags = (v) => {
  if (Array.isArray(v)) return v;
  try { const t = JSON.parse(v || "[]"); return Array.isArray(t) ? t : []; } catch { return []; }
};
const shape = (r) => ({ ...r, area: r.area ?? null, lat: r.lat ?? null, lng: r.lng ?? null, tags: parseTags(r.tags) });

/** Every place of the trip. Shared with the trip's snapshot: one column list, one tags decode. */
// since (a rev) answers only the rows written after it, and those named in also (ids, as for a picture changed):
// GET /api/trips/<id>?since= (src/api/trip.js, migration 0036's indexes).
export async function listPlaces(env, tripId, { since = null, also = [] } = {}) {
  const rows = since === null
    ? await env.DB.prepare(`SELECT ${COLS} FROM places WHERE trip_id = ?1 ORDER BY is_anchor DESC, area, name`).bind(tripId).all()
    // The ids that changed off the (trip, rev) index, then each row by its key: never the whole table.
    : await env.DB.prepare(`SELECT ${COLS.split(",").map((c) => `e.${c.trim()}`).join(", ")} FROM (SELECT id FROM places WHERE trip_id = ?1 AND rev > ?2
        UNION SELECT value FROM json_each(?3)) AS w CROSS JOIN places e ON e.trip_id = ?1 AND e.id = w.id
        ORDER BY e.is_anchor DESC, e.area, e.name`).bind(tripId, since, JSON.stringify(also)).all();
  return (rows.results || []).map(shape);
}

export async function onRequestGet(ctx) {
  return json({ places: await listPlaces(ctx.env, ctx.data.trip.id) });
}

// ── one row ───────────────────────────────────────────────────────────────────────────────

const text = (v, max) => (v === null || v === undefined ? "" : String(v).trim().slice(0, max));
const cap = (what, max) => `${what} is at most ${max} characters.`;

/**
 * One row of a PUT merged onto the place it changes (`before`, or undefined for a new one).
 * Answers { place } (the columns to write) or { error }.
 */
function readPlace(raw, before, { byHand = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "A place is an object with at least an id." };
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined;
  const p = before ? { ...before } : {};
  const isNew = !before;

  if (isNew) {
    const id = readNewId(raw.id);
    if (!id.ok) return { error: id.error };
    p.id = raw.id;
    const missing = ["name", "kind", "subkind", ...(byHand ? [] : ["why"])].filter((k) => !has(k));
    if (missing.length) return { error: `A new place needs id, name, kind, subkind${byHand ? "" : " and why"}; this one has no ${missing.join(", ")}. Every other field is left out when you don't have it from a source.` };
    if (byHand && !has("why")) p.why = "";
  }
  for (const [k, max, what] of [["name", 200, "A name"], ["why", 500, "why"]]) {
    if (!has(k)) continue;
    const v = text(raw[k], 10000);
    if (!v && k === "why" && byHand) { p.why = ""; continue; }
    if (!v) return { error: `${what === "why" ? "why" : "name"} can't be empty.${k === "why" ? " It is one sentence: why this place is on this group's list." : ""}` };
    if (v.length > max) return { error: cap(what, max) };
    p[k] = v;
  }
  for (const [k, max] of [["name_local", 200], ["address", 500], ["address_note", 1000], ["notes", 4000], ["source", 1000], ["phone", 40]]) {
    if (!has(k)) continue;
    const v = text(raw[k], 100000);
    if (v.length > max) return { error: cap(k, max) };
    p[k] = v;
  }
  if (has("website")) {
    const v = text(raw.website, 1000);
    if (v && (!/^https?:\/\/[^\s]+$/i.test(v) || v.length > 500)) return { error: "website is the place's own site, an http or https address, at most 500 characters." };
    p.website = v;
  }
  if (has("kind") || has("subkind")) {
    const k = readPlaceKind(has("kind") ? raw.kind : p.kind, has("subkind") ? raw.subkind : p.subkind);
    if (!k.ok) return { error: k.error };
    p.kind = k.kind;
    p.subkind = k.subkind;
  }
  if (has("area")) p.area = raw.area === null || raw.area === "" ? null : String(raw.area);
  if (has("lat") || has("lng")) {
    const c = readCoordinates(raw.lat, raw.lng);
    if (!c.ok) return { error: c.error };
    p.lat = c.lat;
    p.lng = c.lng;
  }
  if (has("rating") || has("rating_count")) {
    const none = (v) => v === null || v === undefined;
    if (none(raw.rating) && none(raw.rating_count)) { p.rating = 0; p.rating_count = 0; }
    else if (typeof raw.rating !== "number" || !(raw.rating > 0 && raw.rating <= 5) || !Number.isInteger(raw.rating_count) || raw.rating_count < 1) {
      return { error: "rating and rating_count come together or not at all: a rating above 0 up to 5 and the whole number of ratings behind it, both from a source you read, named in source." };
    } else { p.rating = raw.rating; p.rating_count = raw.rating_count; }
  }
  if (has("price_level")) {
    if (raw.price_level === null) p.price_level = 0;
    else if (!Number.isInteger(raw.price_level) || raw.price_level < 1 || raw.price_level > 4) return { error: "price_level is 1 to 4, relative to the destination (1 is cheap for there, 4 a splurge), or left out." };
    else p.price_level = raw.price_level;
  }
  if (has("hours")) {
    if (raw.hours === null || raw.hours === "") p.hours = "";
    else {
      const h = readHours(raw.hours);
      if (!h.ok) return { error: h.error };
      p.hours = h.text;
    }
  }
  if (has("tags")) {
    const t = readTags(raw.tags === null ? [] : raw.tags);
    if (!t.ok) return { error: t.error };
    p.tags = JSON.stringify(t.tags);
  }
  if (has("confidence")) {
    if (!["high", "medium", "low"].includes(raw.confidence)) return { error: "confidence is high, medium or low." };
    p.confidence = raw.confidence;
  }
  if (has("is_anchor")) {
    if (typeof raw.is_anchor !== "boolean") return { error: "is_anchor is true or false." };
    p.is_anchor = raw.is_anchor ? 1 : 0;
  }
  if (has("near_anchor")) p.near_anchor = raw.near_anchor === null ? "" : String(raw.near_anchor);
  if (has("walk_minutes")) {
    if (raw.walk_minutes === null) p.walk_minutes = 0;
    else if (!Number.isInteger(raw.walk_minutes) || raw.walk_minutes < 0 || raw.walk_minutes > 600) return { error: "walk_minutes is the walk from the anchor's door in whole minutes, or left out when it isn't walkable." };
    else p.walk_minutes = raw.walk_minutes;
  }
  if (has("elevation_m")) {
    if (raw.elevation_m === null) p.elevation_m = 0;
    else if (!Number.isInteger(raw.elevation_m) || raw.elevation_m < -500 || raw.elevation_m > 9000) return { error: "elevation_m is whole meters above sea level." };
    else p.elevation_m = raw.elevation_m;
  }
  if (has("checkout")) {
    if (raw.checkout === null || (Array.isArray(raw.checkout) && !raw.checkout.length)) p.checkout = "";
    else {
      const steps = raw.checkout;
      const good = Array.isArray(steps) && steps.length <= 20 && steps.every((s) => s && typeof s.title === "string" && s.title.trim()
        && s.title.trim().length <= 120 && (s.detail === undefined || s.detail === null || (typeof s.detail === "string" && s.detail.length <= 500)));
      if (!good) return { error: "checkout is the steps for leaving, in order, at most 20: each a short title (at most 120 characters) and an optional detail (at most 500)." };
      p.checkout = JSON.stringify(steps.map((s) => (s.detail ? { title: s.title.trim(), detail: s.detail.trim() } : { title: s.title.trim() })));
    }
  }
  if (p.checkout && p.kind !== "lodging") return { error: "checkout is for lodging only: the steps for leaving a stay." };
  return { place: p };
}

// ── PUT places ────────────────────────────────────────────────────────────────────────────

export async function putPlaces({ request, env, data }) {
  const { trip, user } = data;
  const b = await readJson(request);
  if (!Array.isArray(b.places) || !b.places.length) return err(400, "bad places", { need: "places: a list of at least one place" });
  if (b.places.length > ROWS_PER_WRITE_MAX) return err(400, "too many rows", { max: ROWS_PER_WRITE_MAX, reason: `A write is at most ${ROWS_PER_WRITE_MAX} rows: send the rest in another.` });

  const [have, areas] = await Promise.all([
    env.DB.prepare(`SELECT ${COLS} FROM places WHERE trip_id = ?1`).bind(trip.id).all(),
    // In an order of its own (regions, then what's inside them), so a refusal names them the same way whatever
    // index the database reads them by.
    env.DB.prepare("SELECT id, parent, west, south, east, north FROM areas WHERE trip_id = ?1 ORDER BY parent IS NOT NULL, sort, id").bind(trip.id).all(),
  ]);
  const byId = new Map((have.results || []).map((r) => [r.id, r]));
  const areaById = new Map((areas.results || []).map((a) => [a.id, a]));
  const changed = new Map();
  const rows = [];
  b.places.forEach((raw, index) => {
    const id = typeof raw?.id === "string" ? raw.id : null;
    if (id !== null && changed.has(id)) { rows.push({ index, id, error: "This id is in the list twice. Send each place once." }); return; }
    // A person in the app writes by hand; an MCP tool's call carries a change (env.CHANGE).
    const got = readPlace(raw, id === null ? undefined : (byId.get(id) ?? undefined), { byHand: !env.CHANGE });
    if (got.error) rows.push({ index, id, error: got.error });
    else changed.set(got.place.id, { index, place: got.place, isNew: !byId.has(got.place.id) });
  });

  // What a row says about the rest of the trip, as it will be.
  const after = new Map(byId);
  for (const [id, c] of changed) after.set(id, c.place);
  for (const [id, { index, place: p, isNew }] of changed) {
    const raw = b.places[index];
    const touched = (k) => isNew || Object.prototype.hasOwnProperty.call(raw, k);
    if (touched("area") && p.area && !areaById.has(p.area)) {
      rows.push({ index, id, error: `There is no area "${p.area}" in this trip. Use the id of one of its areas (${[...areaById.keys()].slice(0, 12).join(", ") || "it has none yet: add them first"}).` });
      continue;
    }
    if (touched("near_anchor") && p.near_anchor) {
      if (p.near_anchor === id) { rows.push({ index, id, error: "A place can't be near itself: near_anchor is the anchor this place is near." }); continue; }
      if (!after.has(p.near_anchor)) { rows.push({ index, id, error: `There is no place "${p.near_anchor}" in this trip for near_anchor to name.` }); continue; }
    }
    if (touched("area") || touched("lat") || touched("lng")) {
      const why = outsideItsArea(areaById, p.area, p.lat, p.lng);
      if (why) rows.push({ index, id, error: why });
    }
  }
  if (rows.length) return err(400, "bad places", { rows: rows.sort((x, y) => x.index - y.index) });
  // A ceiling against a loop: every member's phone holds every place.
  if (after.size > PLACES_MAX) {
    return err(409, "too many places", { max: PLACES_MAX, reason: `A trip holds at most ${PLACES_MAX} places; this would make ${after.size}.` });
  }

  // Possibly the same place twice: a new one this close to one of the same kind.
  const warnings = [];
  for (const [id, { place: p, isNew }] of changed) {
    if (!isNew || p.lat === null || p.lat === undefined) continue;
    for (const [otherId, o] of after) {
      if (otherId === id || o.kind !== p.kind || o.lat === null || o.lat === undefined) continue;
      if (changed.get(otherId)?.isNew && otherId > id) continue;      // each pair once
      const m = metersBetween(p, o);
      if (m <= DUPLICATE_METERS) warnings.push({ id, near: otherId, meters: Math.round(m), warning: `"${id}" is ${Math.round(m)} m from "${otherId}", also ${p.kind}. If they're the same place, keep one.` });
    }
  }

  const now = nowSec();
  const cols = ["id", ...WRITABLE];
  const sql = `INSERT INTO places (trip_id, ${cols.join(", ")}, created_by, updated_at, rev)
    VALUES (?1, ${cols.map((_, i) => `?${i + 2}`).join(", ")}, ?${cols.length + 2}, ?${cols.length + 3}, ${REV(1)})
    ON CONFLICT(trip_id, id) DO UPDATE SET ${WRITABLE.map((c) => `${c} = excluded.${c}`).join(", ")},
      updated_at = excluded.updated_at, rev = excluded.rev`;
  const defaults = { name_local: "", area: null, address: "", address_note: "", lat: null, lng: null, rating: 0, rating_count: 0,
    price_level: 0, hours: "", phone: "", website: "", notes: "", tags: "[]", near_anchor: "", walk_minutes: 0,
    confidence: "medium", source: "", is_anchor: 0, elevation_m: 0, checkout: "" };
  const { rev } = await write(env, trip.id, [...changed.values()].map(({ place: p }) =>
    env.DB.prepare(sql).bind(trip.id, p.id, ...WRITABLE.map((c) => p[c] ?? defaults[c] ?? null), user.id, now)));

  const written = await env.DB.prepare(
    `SELECT ${COLS} FROM places WHERE trip_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
  ).bind(trip.id, JSON.stringify([...changed.keys()])).all();
  return json({ places: (written.results || []).map(shape), warnings, rev });
}

// ── DELETE places ─────────────────────────────────────────────────────────────────────────

export async function deletePlaces({ request, env, data, params }) {
  const { trip } = data;
  let ids;
  if (params.id !== undefined) {
    try { ids = [decodeURIComponent(params.id)]; } catch { return err(400, "bad id"); }
  } else {
    const b = await readJson(request);
    if (!Array.isArray(b.ids) || !b.ids.length || !b.ids.every((x) => typeof x === "string")) return err(400, "bad ids", { need: "ids: a list of place ids" });
    if (b.ids.length > ROWS_PER_WRITE_MAX) return err(400, "too many rows", { max: ROWS_PER_WRITE_MAX, reason: `A write is at most ${ROWS_PER_WRITE_MAX} rows: send the rest in another.` });
    ids = [...new Set(b.ids)];
  }
  const list = JSON.stringify(ids);
  const [there, events, anchored] = await Promise.all([
    env.DB.prepare("SELECT id FROM places WHERE trip_id = ?1 AND id IN (SELECT value FROM json_each(?2))").bind(trip.id, list).all(),
    env.DB.prepare("SELECT id FROM events WHERE trip_id = ?1 AND place_id IN (SELECT value FROM json_each(?2))").bind(trip.id, list).all(),
    env.DB.prepare(
      `SELECT id FROM places WHERE trip_id = ?1 AND near_anchor IN (SELECT value FROM json_each(?2))
         AND id NOT IN (SELECT value FROM json_each(?2))`,
    ).bind(trip.id, list).all(),
  ]);
  const found = (there.results || []).map((r) => r.id);
  // Already gone is success: a removal sent twice must not turn into an error.
  if (!found.length) return json({ ok: true, deleted: 0, rev: trip.rev });
  const ev = (events.results || []).map((r) => r.id);
  const near = (anchored.results || []).map((r) => r.id);
  if (ev.length || near.length) {
    return err(409, "place in use", {
      reason: "Events, or other places' near_anchor, point at it. Point them elsewhere (or remove them) first.",
      ...(ev.length ? { events: ev.slice(0, 20), event_count: ev.length } : {}),
      ...(near.length ? { places: near.slice(0, 20), place_count: near.length } : {}),
    });
  }
  try {
    const { rev } = await write(env, trip.id, [
      env.DB.prepare(`UPDATE purchases SET place_id = NULL, rev = ${REV(1)} WHERE trip_id = ?1 AND place_id IN (SELECT value FROM json_each(?2))`).bind(trip.id, list),
      // Their pictures go with them (files to the drain).
      ...goneSteps(env, trip.id, "place", list, nowSec()),
      env.DB.prepare("DELETE FROM places WHERE trip_id = ?1 AND id IN (SELECT value FROM json_each(?2))").bind(trip.id, list),
    ]);
    return json({ ok: true, deleted: found.length, rev });
  } catch (e) {
    // An event pointed at it between the look and the write: the answer the look would give.
    if (/FOREIGN KEY/i.test(String(e?.message || e))) return err(409, "place in use", { reason: "An event points at it now. Read the trip again." });
    throw e;
  }
}
