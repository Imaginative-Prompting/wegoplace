// A trip's areas: the named parts of it. A top-level area with bounds is a region the map
// covers ("Lisbon"); a child is a neighborhood under it ("Alfama"). A place points at an area.
//
// Under /api/trips/<trip>/ (the route table checks the caller is on the trip). Any member:
//   GET    areas                  -> { areas }
//   PUT    areas  { areas: [...] } -> { areas, rev }   adds each, or changes the one with that id
//   DELETE areas/<id>             -> { ok, deleted, rev }
//   DELETE areas  { ids: [...] }  -> { ok, deleted, rev }
//
// A PUT is all or nothing: one row that can't be written refuses the call, naming each row
// and what was wrong with it (`rows`). A row that changes an area sends only what changes.
//
// What holds (model §5, §16; the guide is docs/guides/trip-setup.md, "Areas"):
//   * an id a writer chooses: lowercase letters, digits, hyphens (public/js/shared/trip-rules.js);
//   * a child's parent is a top-level area of the same trip, so there are two levels at most;
//   * bounds are all four edges or none (a box across the 180° line has west > east);
//   * a place inside an area with bounds, or under a parent with bounds, lies inside one of
//     the two boxes. Changing a box so a place it holds would fall outside is refused, as a
//     place written outside is;
//   * an area that places point at, or that has children, can't be removed. Removed together
//     with its children (or after its places moved), it can.

import { askForMap } from "../map/ask.js";
import { json, readJson } from "../api/json.js";
import { err, nowSec } from "../api/trip.js";
import { AREA_NAME_MAX, AREAS_MAX, ROWS_PER_WRITE_MAX } from "../../public/js/shared/limits.js";
import { inBounds, readBounds, readNewId } from "../../public/js/shared/trip-rules.js";
import { REV, write } from "./rev.js";

const COLS = "id, name, parent, west, south, east, north, sort, rev";

const shape = (r) => ({
  id: r.id, name: r.name, parent: r.parent ?? null,
  west: r.west ?? null, south: r.south ?? null, east: r.east ?? null, north: r.north ?? null,
  sort: r.sort, rev: r.rev,
});

/** The trip's areas, in their order. Shared with the trip's snapshot. */
export async function listAreas(env, tripId) {
  const rows = await env.DB.prepare(`SELECT ${COLS} FROM areas WHERE trip_id = ?1 ORDER BY sort, id`).bind(tripId).all();
  return (rows.results || []).map(shape);
}

export const getAreas = async ({ env, data }) => json({ areas: await listAreas(env, data.trip.id) });

const boxOf = (a) => (a && a.west !== null && a.west !== undefined ? { west: a.west, south: a.south, east: a.east, north: a.north } : null);

/**
 * Whether a place at (lat, lng) in `areaId` lies where its area allows, given every area of
 * the trip by id. Answers null when it does (or nothing has bounds), else a sentence.
 */
export function outsideItsArea(byId, areaId, lat, lng) {
  if (lat === null || lat === undefined || !areaId) return null;
  const area = byId.get(areaId);
  if (!area) return null;
  const parent = area.parent ? byId.get(area.parent) : null;
  const boxes = [boxOf(area), boxOf(parent)].filter(Boolean);
  if (!boxes.length || boxes.some((b) => inBounds(lat, lng, b))) return null;
  const named = [area, parent].filter((a) => a && boxOf(a)).map((a) => `"${a.id}" (west ${a.west}, south ${a.south}, east ${a.east}, north ${a.north})`);
  return `${lat}, ${lng} is outside the bounds of ${named.join(" and of its parent ")}. Check the coordinates against a map source; if they're right, the area's bounds are too small.`;
}

/** One row of a PUT, merged onto the area it changes (if any). Answers { area } or { error }. */
function readArea(raw, before, now) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "An area is an object with an id and a name." };
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  const id = typeof raw.id === "string" ? raw.id : null;
  if (!before) {
    const ok = readNewId(raw.id);
    if (!ok.ok) return { error: ok.error };
  } else if (!id) return { error: "An area needs its id." };

  const a = before ? { ...before } : { id, name: null, parent: null, west: null, south: null, east: null, north: null, sort: 0, created_at: now };
  if (has("name") || !before) {
    const name = typeof raw.name === "string" ? raw.name.trim().replace(/\s+/g, " ") : "";
    if (!name || [...name].length > AREA_NAME_MAX) return { error: `An area needs a name of 1 to ${AREA_NAME_MAX} characters: what locals and maps call it.` };
    a.name = name;
  }
  if (has("parent")) a.parent = raw.parent === null || raw.parent === "" ? null : String(raw.parent);
  if (has("sort")) {
    if (!Number.isInteger(raw.sort) || raw.sort < 0 || raw.sort > 100000) return { error: "sort is a whole number from 0: the order the group meets the areas in." };
    a.sort = raw.sort;
  }
  for (const k of ["west", "south", "east", "north"]) if (has(k)) a[k] = raw[k];
  const bounds = readBounds(a);
  if (!bounds.ok) return { error: bounds.error };
  Object.assign(a, bounds.bounds ?? { west: null, south: null, east: null, north: null });
  return { area: a };
}

export async function putAreas({ request, env, data }) {
  const { trip, user } = data;
  const b = await readJson(request);
  if (!Array.isArray(b.areas) || !b.areas.length) return err(400, "bad areas", { need: "areas: a list of at least one area" });
  if (b.areas.length > ROWS_PER_WRITE_MAX) return err(400, "too many rows", { max: ROWS_PER_WRITE_MAX, reason: `A write is at most ${ROWS_PER_WRITE_MAX} rows: send the rest in another.` });

  const [have, placed] = await Promise.all([
    env.DB.prepare(`SELECT ${COLS}, created_at FROM areas WHERE trip_id = ?1`).bind(trip.id).all(),
    env.DB.prepare("SELECT id, area, lat, lng FROM places WHERE trip_id = ?1 AND area IS NOT NULL AND lat IS NOT NULL").bind(trip.id).all(),
  ]);
  const byId = new Map((have.results || []).map((r) => [r.id, r]));
  const now = nowSec();
  const rows = [];
  const changed = new Map();
  b.areas.forEach((raw, index) => {
    const id = typeof raw?.id === "string" ? raw.id : undefined;
    if (id !== undefined && changed.has(id)) { rows.push({ index, id, error: "This id is in the list twice. Send each area once." }); return; }
    const got = readArea(raw, id !== undefined ? (changed.get(id) ?? byId.get(id)) : undefined, now);
    if (got.error) rows.push({ index, id: id ?? null, error: got.error });
    else changed.set(got.area.id, got.area);
  });
  if (rows.length) return err(400, "bad areas", { rows });

  // The trip as it will be, and what must hold of it as a whole.
  const after = new Map(byId);
  for (const [id, a] of changed) after.set(id, a);
  if (after.size > AREAS_MAX) return err(400, "too many areas", { max: AREAS_MAX, reason: `A trip has at most ${AREAS_MAX} areas; this would make ${after.size}.` });
  for (const [id, a] of changed) {
    const index = b.areas.findIndex((r) => r?.id === id);
    if (!a.parent) continue;
    const parent = after.get(a.parent);
    if (a.parent === id) rows.push({ index, id, error: "An area can't be its own parent." });
    else if (!parent) rows.push({ index, id, error: `There is no area "${a.parent}" in this trip to be its parent. Send the parent in the same list, or first.` });
    else if (parent.parent) rows.push({ index, id, error: `"${a.parent}" is itself under "${parent.parent}". A neighborhood goes under a top-level area: two levels at most.` });
  }
  for (const [id, a] of changed) {
    if (!a.parent) continue;
    const kids = [...after.values()].filter((c) => c.parent === id).map((c) => c.id);
    if (kids.length) rows.push({ index: b.areas.findIndex((r) => r?.id === id), id, error: `"${id}" has areas under it (${kids.slice(0, 5).join(", ")}), so it can't go under another: two levels at most.` });
  }
  if (rows.length) return err(400, "bad areas", { rows });
  const outside = (placed.results || [])
    .map((p) => ({ id: p.id, why: outsideItsArea(after, p.area, p.lat, p.lng) }))
    .filter((p) => p.why);
  if (outside.length) {
    return err(409, "places outside", {
      reason: `With these bounds, ${outside.length} place(s) would lie outside their area. Make the bounds hold them, or correct the places first.`,
      places: outside.slice(0, 20),
    });
  }

  // Top-level areas first: a child's row points at its parent's.
  const order = [...changed.values()].sort((x, y) => (x.parent ? 1 : 0) - (y.parent ? 1 : 0));
  const { rev } = await write(env, trip.id, order.map((a) => env.DB.prepare(
    `INSERT INTO areas (trip_id, id, name, parent, west, south, east, north, sort, created_by, created_at, updated_at, rev)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ${REV(1)})
     ON CONFLICT(trip_id, id) DO UPDATE SET name = excluded.name, parent = excluded.parent, west = excluded.west,
       south = excluded.south, east = excluded.east, north = excluded.north, sort = excluded.sort,
       updated_at = excluded.updated_at, rev = excluded.rev`,
  ).bind(trip.id, a.id, a.name, a.parent, a.west, a.south, a.east, a.north, a.sort, user.id, now)));
  await askForMap(env, trip.id);
  return json({ areas: await listAreas(env, trip.id), rev });
}

/** DELETE areas/<id>, or DELETE areas { ids }. */
export async function deleteAreas({ request, env, data, params }) {
  const { trip } = data;
  let ids;
  if (params.id !== undefined) {
    try { ids = [decodeURIComponent(params.id)]; } catch { return err(400, "bad id"); }
  } else {
    const b = await readJson(request);
    if (!Array.isArray(b.ids) || !b.ids.length || !b.ids.every((x) => typeof x === "string")) return err(400, "bad ids", { need: "ids: a list of area ids" });
    if (b.ids.length > ROWS_PER_WRITE_MAX) return err(400, "too many rows", { max: ROWS_PER_WRITE_MAX, reason: `A write is at most ${ROWS_PER_WRITE_MAX} rows: send the rest in another.` });
    ids = [...new Set(b.ids)];
  }
  const going = new Set(ids);
  const [have, placed] = await Promise.all([
    env.DB.prepare("SELECT id, parent FROM areas WHERE trip_id = ?1").bind(trip.id).all(),
    env.DB.prepare("SELECT id, area FROM places WHERE trip_id = ?1 AND area IS NOT NULL").bind(trip.id).all(),
  ]);
  const areas = have.results || [];
  const there = ids.filter((id) => areas.some((a) => a.id === id));
  // Already gone is success: a removal sent twice must not turn into an error.
  if (!there.length) return json({ ok: true, deleted: 0, rev: trip.rev });
  const kept = areas.filter((a) => a.parent && going.has(a.parent) && !going.has(a.id)).map((a) => a.id);
  const pointing = (placed.results || []).filter((p) => going.has(p.area)).map((p) => p.id);
  if (kept.length || pointing.length) {
    return err(409, "area in use", {
      reason: "An area that places point at, or that has areas under it, can't be removed. Move its places (or remove them), and remove or move its areas, first; or rename it.",
      ...(pointing.length ? { places: pointing.slice(0, 20), place_count: pointing.length } : {}),
      ...(kept.length ? { areas: kept } : {}),
    });
  }
  // Children before parents.
  const order = there.sort((x, y) => (areas.find((a) => a.id === y)?.parent ? 1 : 0) - (areas.find((a) => a.id === x)?.parent ? 1 : 0));
  const { rev } = await write(env, trip.id, order.map((id) =>
    env.DB.prepare("DELETE FROM areas WHERE trip_id = ?1 AND id = ?2").bind(trip.id, id)));
  await askForMap(env, trip.id);
  return json({ ok: true, deleted: there.length, rev });
}
