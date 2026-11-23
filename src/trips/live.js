// Live updates, the Worker's side (model §10; the room is src/trips/room.js).
//
// GET /api/trips/<id>/live, as a WebSocket: a tab of someone on the trip hears {"rev": n} each
// time the trip changes, and reads through the routes as it always has. Only the site's own
// pages may open it (the Origin header), only for someone on the trip (the route table's
// inTrip(), as every trip route), and the room is told who the person is by this Worker alone:
// the request it hands the room is made here, so no header the browser sent reaches it.
//
// tellRoom() is how a write reaches the room. It runs after the response where the Worker can
// wait for it (env.LATER, from ctx.waitUntil), and a room that can't be reached is logged, never
// a failed write: nothing depends on the socket for being right. A tab without one asks
// GET …/rev, as before.
//
// Locally, ROOM_FAIL=on makes every room unreachable (checks only: honored on this machine's
// own address, like COUNT_QUERIES).

import { json } from "../api/json.js";
import { SESSION_COOKIE } from "../accounts/sessions.js";
import { ownOrigin as pageOrigin, readCookie, sha256Hex } from "../accounts/util.js";
import { errorLine } from "../log.js";

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Tells a trip's room something (src/trips/room.js tell()). Never throws. */
export async function tellRoom(env, tripId, message) {
  if (!env.ROOMS || !tripId) return;
  const go = (async () => {
    if (env.ROOM_FAIL === "on" && LOCAL.test(env.PUBLIC_ORIGIN ?? "")) throw new Error("the room can't be reached (ROOM_FAIL=on)");
    await env.ROOMS.getByName(tripId).tell(message);
  })().catch((e) => console.log(JSON.stringify({ room_unreachable: tripId, error: errorLine(e, env) })));
  if (env.LATER) env.LATER(go);
  else await go;
}

/** Someone's sockets leave every trip they're on: all of them (`user`), or one session's. */
export async function leaveRooms(env, userId, { session = null } = {}) {
  const trips = (await env.DB.prepare("SELECT trip_id FROM trip_members WHERE user_id = ?1 AND left_at IS NULL").bind(userId).all()).results ?? [];
  await Promise.all(trips.map((t) => tellRoom(env, t.trip_id, session ? { session } : { drop: userId })));
}

/** The hash a session is kept under, from the request's cookie (null without one). */
export async function sessionHash(request) {
  const token = readCookie(request, SESSION_COOKIE);
  return token ? sha256Hex(token) : null;
}

/**
 * Whether the page opening it is this site's, here: the site's address this request came to
 * (www's page to www, the other's to the other: their sessions are their own), or, on an address
 * that isn't one of the site's (a local server reached at 127.0.0.1), PUBLIC_ORIGIN or that
 * address itself.
 */
const ownOrigin = (request, env) => {
  const origin = request.headers.get("Origin");
  return !!origin && (origin === pageOrigin(request, env) || origin === new URL(request.url).origin);
};

/** GET /api/trips/<id>/live: the trip's room, for a tab of someone on it. */
export async function openLive({ request, env, data }) {
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") return json({ error: "websocket only" }, 426);
  // A page on another site can't open it through a person's browser, even to learn when the trip changes.
  if (!ownOrigin(request, env)) return json({ error: "cross site" }, 403);
  if (!env.ROOMS) return json({ error: "live updates off" }, 503);
  const session = await sessionHash(request);
  if (!session) return json({ error: "unauthorized" }, 401);
  // A request of our own: no header the browser sent reaches the room.
  return env.ROOMS.getByName(data.trip.id).fetch("https://room/live", {
    headers: { Upgrade: "websocket", "x-wgp-user": data.user.id, "x-wgp-session": session, "x-wgp-rev": String(data.trip.rev) },
  });
}
