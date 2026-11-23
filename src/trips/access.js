// Who may reach a trip: the people on it, and nobody else.
//
// Every route of a trip has the trip's id in its address (/api/trips/<id>/…), and the route
// table wraps each one in inTrip(). So membership is checked in one place, once a request, by
// one query, before the handler runs; a handler never looks the trip up or asks who is on it.
// It reads:
//   ctx.data.trip   the trip's row
//   ctx.data.host   whether the caller is its host
//
// A trip that doesn't exist and a trip the caller isn't on answer the same 404, so an id
// tells nobody whether there is a trip behind it. Someone who left, or was removed, is not on
// the trip from their next request.

import { json } from "../api/json.js";

const TRIP_COLS = `t.id, t.name, t.starts_on, t.ends_on, t.default_tz, t.currencies, t.collage_seed,
    t.collage_version, t.host_id, t.created_by, t.created_at, t.updated_at, t.rev, t.interests, t.tiles, t.data_rev, t.message_seq,
    t.tiles_state, t.tiles_source, t.tiles_version, t.tiles_bytes, t.tiles_at, t.tiles_glyphs, t.tiles_note`;

const FOR_MEMBER = `SELECT ${TRIP_COLS} FROM trips t JOIN trip_members m ON m.trip_id = t.id
  WHERE t.id = ?1 AND m.user_id = ?2 AND m.left_at IS NULL`;

export const noSuchTrip = () => json({ error: "no such trip", reason: "There's no trip by that id that this account is on." }, 404);

/** The trip's row if `userId` is on it now, else null. */
export const tripFor = (env, tripId, userId) => env.DB.prepare(FOR_MEMBER).bind(tripId, userId).first();

/** Wraps a handler of a trip's route: it runs only for someone on the trip in the address. */
export function inTrip(handler) {
  const wrapped = async (ctx) => {
    const user = ctx.data.user;
    if (!user) return json({ error: "unauthorized" }, 401);
    let id;
    try { id = decodeURIComponent(String(ctx.params.trip ?? "")); } catch { return noSuchTrip(); }
    const trip = id ? await tripFor(ctx.env, id, user.id) : null;
    if (!trip) return noSuchTrip();
    ctx.data.trip = trip;
    ctx.data.host = trip.host_id === user.id;
    return handler(ctx);
  };
  // The route check reads these: every row under /api/trips/:trip must be wrapped.
  wrapped.inTrip = true;
  wrapped.inner = handler;
  return wrapped;
}

export const HOST_ONLY = "Only the trip's host can do that.";
/** Only the trip's host may do this. */
export const hostOnly = () => json({ error: "forbidden", reason: HOST_ONLY }, 403);

/**
 * The trip's own currencies, in its order (the first is its main one), from the JSON its row
 * keeps. A value that isn't a list of codes is read as none: it costs this field, not the trip.
 */
export function tripCurrencies(t) {
  if (!t.currencies) return [];
  try {
    const v = JSON.parse(t.currencies);
    return Array.isArray(v) ? v.filter((c) => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A trip as the routes give it: dates that aren't known yet are null. `currencies` is the
 * trip's own list; the whole trip's top-level `currencies` (src/api/trip.js) is a different
 * thing, every currency the trip's people use, this list first.
 */
export const tripShape = (t) => ({
  id: t.id, name: t.name, starts_on: t.starts_on || null, ends_on: t.ends_on || null,
  default_tz: t.default_tz, currencies: tripCurrencies(t), interests: t.interests ?? "", host_id: t.host_id, created_by: t.created_by ?? null,
  collage_seed: t.collage_seed ?? null, collage_version: t.collage_version ?? null,
  created_at: t.created_at, updated_at: t.updated_at, rev: t.rev,
});
