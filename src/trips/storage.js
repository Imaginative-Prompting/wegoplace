// Storage: what a host uses, read from the rows, and the one check every new byte passes.
//
// A free account holds FREE_STORAGE_BYTES across every trip it hosts (model §7). What counts,
// for each trip the account hosts:
//   * its stored files (originals and thumbnails: media_objects in state 'stored');
//   * its uploads still under way, at their declared size, for RESERVATION_SECONDS from when
//     they began (an abandoned one stops counting by itself; the drain removes its row);
//   * the boards shared from it that aren't revoked: the board, its looping video, and the
//     photographs at their own resolution (collage_shares, collage_share_items);
//   * the documents people on it gave the assistant (ai_files, migration 0045): each one's original and its text, and
//     while it is being read (and for RESERVATION_SECONDS at most), what its text may take.
// A map the server cuts doesn't count; one the host uploads does (it is a file: role 'map').
// Nothing here is a stored total: handing a trip over, deleting one, or
// revoking a board changes the sum because the rows change, and files no row names (the
// leftovers of the time before this) count against nobody.
//
// A WRITE THAT WOULDN'T FIT IS REFUSED BEFORE ANY BYTES MOVE. Every write of a file begins
// with ONE conditional insert of its row, at its declared size, which succeeds only if the
// host's use plus this fits the limit (fitsSql below). D1 runs a statement whole, so two
// uploads can't both slip into the last megabyte.
//
// The limit is read through limitFor(host), and only there: the free limit, or the plan's pool
// while the host has the plan (model §20). When a plan ends nothing is removed: every new byte is
// refused until what they hold fits the free limit again, or they have the plan again (§7).

import { FREE_STORAGE_BYTES, RESERVATION_SECONDS } from "../../public/js/shared/limits.js";
import { formatBytes } from "../../public/js/shared/bytes.js";
import { json } from "../api/json.js";
import { entitlement, planOffered } from "../billing/plan.js";

/** The free limit: FREE_STORAGE_BYTES, or STORAGE_LIMIT_BYTES in wrangler.jsonc's vars (a site of its own; the checks set a small one, to fill it). */
export function freeLimit(env) {
  const set = Number(env.STORAGE_LIMIT_BYTES);
  return Number.isFinite(set) && set > 0 ? set : FREE_STORAGE_BYTES;
}

/** What an account may hold across the trips it hosts: the plan's pool while it has the plan, else the free limit. */
export async function limitFor(env, hostId) {
  const free = freeLimit(env);
  // entitlement() answers a grant whether or not the site sells the plan, and null for everyone else while it doesn't.
  const plan = await entitlement(env, hostId);
  return plan?.active ? Math.max(plan.poolBytes, free) : free;
}

/** The moment before which an upload under way no longer holds its bytes. */
export const reservationCut = (now) => now - RESERVATION_SECONDS;

/**
 * SQL for the bytes a scope holds, where `scope` is a WHERE fragment over trips `t` (for one
 * host: "t.host_id = ?H"; for one trip: "t.id = ?T") and `cut` names the parameter holding
 * reservationCut(now).
 */
export function heldSql(scope, cut) {
  return `(
    (SELECT COALESCE(SUM(o.bytes), 0) FROM media_objects o JOIN trips t ON t.id = o.trip_id
      WHERE ${scope} AND (o.state = 'stored' OR (o.state = 'pending' AND o.created_at > ${cut})))
  + (SELECT COALESCE(SUM(COALESCE(s.bytes, 0) + COALESCE(s.video_bytes, 0)), 0) FROM collage_shares s JOIN trips t ON t.id = s.trip_id
      WHERE ${scope} AND s.revoked_at IS NULL)
  + (SELECT COALESCE(SUM(i.bytes), 0) FROM collage_share_items i JOIN collage_shares s ON s.id = i.share_id JOIN trips t ON t.id = s.trip_id
      WHERE ${scope} AND s.revoked_at IS NULL)
  + (SELECT COALESCE(SUM(f.bytes + f.text_bytes + CASE WHEN f.state = 'reading' AND f.created_at > ${cut} THEN f.text_reserve ELSE 0 END), 0)
      FROM ai_files f JOIN trips t ON t.id = f.trip_id WHERE ${scope})
  )`;
}

/**
 * The condition a new row's insert carries: the host of trip ?T holds `?needed` more and still
 * fits `?limit`. Parameters are named by number, as the caller binds them.
 */
export function fitsSql({ trip, needed, limit, cut }) {
  return `(${heldSql(`t.host_id = (SELECT host_id FROM trips WHERE id = ${trip})`, cut)} + ${needed}) <= ${limit}`;
}

/**
 * Whether `needed` more bytes fit the host's room now, asked before a write: a refusal for room then writes nothing
 * (the write itself still carries fitsSql, for two writes at once).
 */
export async function fitsNow(env, trip, needed, now) {
  const r = await env.DB.prepare(`SELECT ${fitsSql({ trip: "?1", needed: "?2", limit: "?3", cut: "?4" })} AS yes`)
    .bind(trip.id, needed, await limitFor(env, trip.host_id), reservationCut(now)).first();
  return !!r?.yes;
}

/** What one trip holds now, in bytes. */
export async function tripBytes(env, tripId, now) {
  const r = await env.DB.prepare(`SELECT ${heldSql("t.id = ?1", "?2")} AS bytes`).bind(tripId, reservationCut(now)).first();
  return Number(r?.bytes) || 0;
}

/**
 * The host's meter: what each trip they host holds, what is held by uploads under way (who,
 * how much, since when), the total and the limit.
 */
export async function hostMeter(env, hostId, now) {
  const cut = reservationCut(now);
  const [trips, reserved, total] = await Promise.all([
    env.DB.prepare(
      `SELECT x.id, x.name, ${heldSql("t.id = x.id", "?2")} AS bytes,
         (SELECT COUNT(*) FROM media_objects o WHERE o.trip_id = x.id AND o.state = 'stored') AS files,
         (SELECT COUNT(*) FROM pictures p WHERE p.trip_id = x.id AND p.role = 'picture') AS pictures,
         (SELECT COALESCE(SUM(p.bytes), 0) FROM pictures p WHERE p.trip_id = x.id AND p.role = 'picture') AS picture_bytes,
         (SELECT COUNT(*) FROM pictures p WHERE p.trip_id = x.id AND p.role = 'receipt') AS receipts,
         (SELECT COALESCE(SUM(p.bytes), 0) FROM pictures p WHERE p.trip_id = x.id AND p.role = 'receipt') AS receipt_bytes,
         (SELECT COALESCE(SUM(o.bytes), 0) FROM media_objects o WHERE o.trip_id = x.id AND o.state = 'stored' AND o.role = 'map') AS map_bytes,
         (SELECT COUNT(*) FROM files_held h WHERE h.trip_id = x.id) AS held,
         (SELECT COALESCE(SUM(o.bytes), 0) FROM files_held h JOIN media_objects o ON o.r2_key = h.r2_key WHERE h.trip_id = x.id) AS held_bytes
       FROM trips x WHERE x.host_id = ?1 ORDER BY bytes DESC, x.name`,
    ).bind(hostId, cut).all(),
    env.DB.prepare(
      `SELECT o.r2_key AS key, o.trip_id, t.name AS trip_name, o.user_id, u.name AS user_name, o.bytes, o.created_at AS since
       FROM media_objects o JOIN trips t ON t.id = o.trip_id LEFT JOIN users u ON u.id = o.user_id
       WHERE t.host_id = ?1 AND o.state = 'pending' AND o.created_at > ?2 ORDER BY o.created_at`,
    ).bind(hostId, cut).all(),
    env.DB.prepare(`SELECT ${heldSql("t.host_id = ?1", "?2")} AS bytes`).bind(hostId, cut).first(),
  ]);
  const reservations = (reserved.results || []).map((r) => ({ ...r, bytes: Number(r.bytes) || 0 }));
  return {
    limit: await limitFor(env, hostId),
    used: Number(total?.bytes) || 0,
    reserved: reservations.reduce((s, r) => s + r.bytes, 0),
    trips: (trips.results || []).map((t) => ({
      id: t.id, name: t.name, bytes: Number(t.bytes) || 0, files: Number(t.files) || 0,
      pictures: { count: Number(t.pictures) || 0, bytes: Number(t.picture_bytes) || 0 },
      receipts: { count: Number(t.receipts) || 0, bytes: Number(t.receipt_bytes) || 0 },
      // Pictures a change replaced or removed, kept for its undo (src/trips/changes.js).
      held: { count: Number(t.held) || 0, bytes: Number(t.held_bytes) || 0 },
      // A map the host uploaded (a map the server cut counts against nobody).
      map: { bytes: Number(t.map_bytes) || 0 },
    })),
    reservations,
  };
}

/**
 * The refusal when a write doesn't fit, from where the caller stands. The host sees every trip
 * they host, largest first; anyone else sees only this trip, the host's total and the limit
 * (a member of one trip learns nothing of the host's others). Either way it says what is in
 * the way, uploads under way included, and never mentions a price. Where the site offers the
 * plan and the host doesn't have it, it names the third way out (§20): the host is told where to
 * get more room, anyone else that the host can (`more_room`, for the app to link).
 */
export async function storageFull(env, { trip, user, needed, now }) {
  const meter = await hostMeter(env, trip.host_id, now);
  let more = null;
  if (planOffered(env) && !(await entitlement(env, trip.host_id))?.active) {
    const host = await env.DB.prepare("SELECT name FROM users WHERE id = ?1").bind(trip.host_id).first();
    more = { host: host?.name || "The host" };
  }
  const left = Math.max(0, meter.limit - meter.used);
  const here = meter.trips.find((t) => t.id === trip.id)?.bytes ?? 0;
  const isHost = user.id === trip.host_id;
  const reservedNote = meter.reserved
    ? ` ${formatBytes(meter.reserved)} of what ${isHost ? "you use" : "the host uses"} is held by uploads still under way; cancelling one frees it at once.`
    : "";
  const reason = isHost
    ? `You have ${formatBytes(left)} left of ${formatBytes(meter.limit)} across the trips you host, and this needs ${formatBytes(needed)}.${reservedNote} `
      + `${meter.trips.slice(0, 3).map((t) => `"${t.name}" uses ${formatBytes(t.bytes)}`).join("; ")}. Deleting photos and videos, or a whole trip, frees what they hold.`
      + (more ? " Or get more room, on your account page." : "")
    : `This trip's host has ${formatBytes(left)} left of ${formatBytes(meter.limit)}, and this needs ${formatBytes(needed)}. This trip uses ${formatBytes(here)}.${reservedNote} `
      + (more ? `Only the host can free space, or ${more.host} can get more room.` : "Only the host can free space.");
  return json({
    error: "storage full", reason, needed, limit: meter.limit, used: meter.used, reserved: meter.reserved,
    trip_bytes: here,
    ...(more ? { more_room: isHost ? { where: "/account#plan" } : { host: more.host } } : {}),
    ...(isHost ? { trips: meter.trips, reservations: meter.reservations } : {}),
  }, 413);
}

/** What the trip's snapshot says of storage: every member may see how much room the host has. */
export async function storageLine(env, trip, now) {
  const cut = reservationCut(now);
  const r = await env.DB.prepare(`SELECT ${heldSql("t.host_id = ?1", "?2")} AS host_used, ${heldSql("t.id = ?3", "?2")} AS trip_bytes`)
    .bind(trip.host_id, cut, trip.id).first();
  return { host_id: trip.host_id, limit: await limitFor(env, trip.host_id), host_used: Number(r?.host_used) || 0, trip_bytes: Number(r?.trip_bytes) || 0 };
}

/** GET /api/account/storage: the meter of the trips the caller hosts. */
export async function getAccountStorage({ env, data }) {
  return json(await hostMeter(env, data.user.id, Math.floor(Date.now() / 1000)));
}
