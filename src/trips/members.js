// The people on a trip: who they are, leaving, removing someone, handing the trip over.
//
// Under /api/trips/<trip>/ (the route table checks the caller is on the trip):
//   GET    members            -> { members }            everyone who is or has been on it
//   GET    people             -> { trip, you, members, links, handover, storage, rev }
//                                what the page of a trip's people (public/trip-people.html, at
//                                /trips/<id>) shows, in one read and without the trip's plan
//   DELETE members/<user>     -> { ok, left, rev }      yourself: leave. Someone else: host only
//   POST   host   { to }      -> { handover, rev }      host only: offer the trip to a member
//   DELETE host               -> { ok, withdrawn, rev } host only: take the offer back
//   POST   host/accept        -> { trip, rev }          the member it's offered to: they host it now
//   POST   host/decline       -> { ok, rev }            the member it's offered to
//
// Leaving and being removed are almost the same change: the row stays, with `left_at`. What
// the person wrote and paid stays on the trip under their name (the money other people owe is
// made of it); they stop being able to read or write the trip from their next request. The
// difference is coming back: someone who left comes back by any link that still works;
// someone the host removed only by a link made after the removal (`removed_rev`, migration
// 0018), so a link they already hold doesn't undo the host's choice.
//
// A trip has exactly one host, named on the trip's row. The host can't leave: they offer the
// trip to another member, who accepts, or delete it.

import { pictureShape } from "./pictures.js";
import { TRIPS_HOSTED_MAX } from "../../public/js/shared/limits.js";
import { formatBytes } from "../../public/js/shared/bytes.js";
import { heldSql, limitFor, reservationCut, storageLine } from "./storage.js";
import { linkRows } from "./links.js";
import { json, readJson } from "../api/json.js";
import { err, listMembers, nowSec } from "../api/trip.js";
import { hostOnly, tripShape } from "./access.js";
import { REV, write } from "./rev.js";
import { guestRefused, isGuest, waysIn } from "../accounts/guests.js";
import { FILES_DELETES } from "../assistant/files.js";

const noSuchMember = (id) => err(404, "no such member", { id, reason: `Nobody on this trip has the id "${String(id).slice(0, 64)}".` });
const decoded = (part) => { try { return decodeURIComponent(String(part ?? "")); } catch { return null; } };

export const getMembers = async ({ env, data }) => json({ members: await listMembers(env, data.trip) });

export async function getPeople({ env, data }) {
  const { trip, user } = data;
  const now = nowSec();
  const [members, links, offer, storage, cover] = await Promise.all([
    listMembers(env, trip),
    linkRows(env, trip.id, now),
    env.DB.prepare("SELECT to_user, offered_by, offered_at, rev FROM trip_handovers WHERE trip_id = ?1").bind(trip.id).first(),
    storageLine(env, trip, now),
    // The trip's cover, as the snapshot carries it: the trip's own page changes it (src/trips/pictures.js).
    env.DB.prepare("SELECT * FROM pictures WHERE trip_id = ?1 AND target_kind = 'cover' AND target_id = ''").bind(trip.id).first(),
  ]);
  return json({
    trip: { ...tripShape(trip), cover: pictureShape(cover) }, you: { id: user.id, host: trip.host_id === user.id },
    members, links, handover: handoverShape(offer), storage, rev: trip.rev,
  });
}

export async function removeMember({ env, data, params }) {
  const { user, trip, host } = data;
  const target = decoded(params.user);
  if (!target) return noSuchMember(params.user);
  const self = target === user.id;
  if (!self && !host) return hostOnly();
  if (target === trip.host_id) {
    return err(409, "the host can't leave", { reason: "hand the trip to another member first, or delete the trip" });
  }

  const row = await env.DB.prepare("SELECT left_at, removed_rev FROM trip_members WHERE trip_id = ?1 AND user_id = ?2")
    .bind(trip.id, target).first();
  if (!row) return noSuchMember(target);
  if (row.left_at !== null) {
    // Already gone. Leaving twice, or a removal sent twice, is success that changes nothing.
    // But the host removing someone who left on their own is a choice of its own: it marks them
    // removed (`left_at` stays the day they left), so a link they already hold doesn't bring
    // them back.
    if (self || row.removed_rev !== null) return json({ ok: true, left: false, rev: trip.rev });
    const { rev } = await write(env, trip.id, [
      env.DB.prepare(
        `UPDATE trip_members SET removed_rev = ${REV(1)}, rev = ${REV(1)}
         WHERE trip_id = ?1 AND user_id = ?2 AND left_at IS NOT NULL AND removed_rev IS NULL`,
      ).bind(trip.id, target),
    ]);
    return json({ ok: true, left: false, rev });
  }

  // The host is excluded in the statement as well: a hand-over that lands between the read
  // above and this write must not leave the trip with a host who is not on it.
  const { rev, results } = await write(env, trip.id, [
    env.DB.prepare(
      `UPDATE trip_members SET left_at = ?3, removed_rev = CASE WHEN ?4 THEN NULL ELSE ${REV(1)} END, rev = ${REV(1)}
       WHERE trip_id = ?1 AND user_id = ?2 AND left_at IS NULL
         AND user_id != (SELECT host_id FROM trips WHERE id = ?1)`,
    ).bind(trip.id, target, nowSec(), self ? 1 : 0),
    // An offer of the trip to someone who has gone ends with them.
    env.DB.prepare("DELETE FROM trip_handovers WHERE trip_id = ?1 AND to_user = ?2").bind(trip.id, target),
    // The documents they gave the assistant on this trip go with them: their rows now, both
    // objects to the drain; the rows they made on the trip stay. Only if they did leave (the host can't).
    ...FILES_DELETES(env, "trip_id = ?1 AND user_id = ?2 AND EXISTS (SELECT 1 FROM trip_members m WHERE m.trip_id = ?1 AND m.user_id = ?2 AND m.left_at IS NOT NULL)", [trip.id, target], nowSec()),
  ], { drop: target });
  if (!results[0].meta.changes) {
    return err(409, "the host can't leave", { reason: "hand the trip to another member first, or delete the trip" });
  }
  return json({ ok: true, left: true, rev });
}

// ── handing the trip over: an offer the other person accepts ──────────────────────────────
// Hosting costs something: the trip's storage counts against the host, and a host can't leave
// or delete their account while the trip has other people on it. So nobody is made a host
// without saying yes (model §4). The host offers the trip to a member; that member accepts or
// declines; the host can take the offer back; nothing changes until it is accepted. One offer
// a trip at a time (a new one replaces it), and it ends if that member leaves or is removed.
//
//   POST   host         { to }  -> 201 { handover, rev }   host only: offer (or offer to someone else)
//   DELETE host                 -> { ok, withdrawn, rev }  host only: take it back
//   POST   host/accept          -> { trip, rev }           the member offered it: they host it now
//   POST   host/decline         -> { ok, rev }             the member offered it: the offer ends
// Accepting checks the trip fits: what the new host already holds, with uploads under way, plus
// what this trip holds, within their limit (src/trips/storage.js); and their hosted trips.

export const handoverShape = (h) => (h ? { to: h.to_user, offered_by: h.offered_by, offered_at: h.offered_at, rev: h.rev } : null);

export async function offerHost({ request, env, data }) {
  const { user, trip, host } = data;
  if (!host) return hostOnly();
  const to = (await readJson(request)).to;
  if (typeof to !== "string" || !to) return err(400, "bad to", { need: "the id of a member of this trip", reason: "Say who the trip is offered to: the id of someone on it." });
  if (to === user.id) return err(400, "bad to", { reason: "you already host this trip" });
  const member = await env.DB.prepare(
    `SELECT u.name, u.guest FROM trip_members m JOIN users u ON u.id = m.user_id
     WHERE m.trip_id = ?1 AND m.user_id = ?2 AND m.left_at IS NULL AND u.deleted_at IS NULL`,
  ).bind(trip.id, to).first();
  if (!member) return noSuchMember(to);
  // Hosting needs an account (model §22): a guest's only way in is one phone.
  if (member.guest) return guestRefused(env, `${member.name} is a guest: they can host once they add ${waysIn(env)}.`);
  const now = nowSec();
  const { rev } = await write(env, trip.id, [env.DB.prepare(
    `INSERT INTO trip_handovers (trip_id, to_user, offered_by, offered_at, rev) VALUES (?1, ?2, ?3, ?4, ${REV(1)})
     ON CONFLICT(trip_id) DO UPDATE SET to_user = excluded.to_user, offered_by = excluded.offered_by,
       offered_at = excluded.offered_at, rev = excluded.rev`,
  ).bind(trip.id, to, user.id, now)]);
  return json({ handover: { to, offered_by: user.id, offered_at: now, rev }, rev }, 201);
}

export async function withdrawHost({ env, data }) {
  const { trip, host } = data;
  if (!host) return hostOnly();
  const there = await env.DB.prepare("SELECT 1 FROM trip_handovers WHERE trip_id = ?1").bind(trip.id).first();
  if (!there) return json({ ok: true, withdrawn: false, rev: trip.rev });
  const { rev } = await write(env, trip.id, [env.DB.prepare("DELETE FROM trip_handovers WHERE trip_id = ?1").bind(trip.id)]);
  return json({ ok: true, withdrawn: true, rev });
}

const noOffer = () => err(404, "no offer", { reason: "This trip isn't offered to you." });

export async function declineHost({ env, data }) {
  const { trip, user } = data;
  const offer = await env.DB.prepare("SELECT to_user FROM trip_handovers WHERE trip_id = ?1").bind(trip.id).first();
  if (!offer || offer.to_user !== user.id) return noOffer();
  const { rev } = await write(env, trip.id, [env.DB.prepare("DELETE FROM trip_handovers WHERE trip_id = ?1 AND to_user = ?2").bind(trip.id, user.id)]);
  return json({ ok: true, rev });
}

export async function acceptHost({ env, data }) {
  const { trip, user } = data;
  if (isGuest(user)) return guestRefused(env, `You're a guest. Add ${waysIn(env)} on your account page, then accept.`);
  const offer = await env.DB.prepare("SELECT to_user, offered_by FROM trip_handovers WHERE trip_id = ?1").bind(trip.id).first();
  if (!offer || offer.to_user !== user.id) return noOffer();
  const now = nowSec();
  const hosted = await env.DB.prepare("SELECT COUNT(*) AS n FROM trips WHERE host_id = ?1").bind(user.id).first();
  if ((hosted?.n ?? 0) >= TRIPS_HOSTED_MAX) {
    return err(409, "too many trips", { max: TRIPS_HOSTED_MAX, reason: `You already host ${TRIPS_HOSTED_MAX} trips.` });
  }
  // The trip has to fit what the new host may hold: everything they hold now, plus this trip.
  const limit = await limitFor(env, user.id);
  const cut = reservationCut(now);
  const { rev, results } = await write(env, trip.id, [
    env.DB.prepare(
      `UPDATE trips SET host_id = ?2, updated_at = ?3
       WHERE id = ?1 AND host_id = ?4
         AND EXISTS (SELECT 1 FROM trip_handovers h WHERE h.trip_id = ?1 AND h.to_user = ?2)
         AND EXISTS (SELECT 1 FROM trip_members m JOIN users u ON u.id = m.user_id
                     WHERE m.trip_id = ?1 AND m.user_id = ?2 AND m.left_at IS NULL AND u.deleted_at IS NULL)
         AND (SELECT COUNT(*) FROM trips WHERE host_id = ?2) < ?5
         AND ${heldSql("t.host_id = ?2", "?6")} + ${heldSql("t.id = ?1", "?6")} <= ?7`,
    ).bind(trip.id, user.id, now, trip.host_id, TRIPS_HOSTED_MAX, cut, limit),
    // Both people's rows changed what they say (`role`), so both take the rev, if it happened;
    // and the offer is done.
    env.DB.prepare(
      `UPDATE trip_members SET rev = ${REV(1)}
       WHERE trip_id = ?1 AND user_id IN (?2, ?3) AND (SELECT host_id FROM trips WHERE id = ?1) = ?2`,
    ).bind(trip.id, user.id, trip.host_id),
    env.DB.prepare("DELETE FROM trip_handovers WHERE trip_id = ?1 AND (SELECT host_id FROM trips WHERE id = ?1) = ?2").bind(trip.id, user.id),
  ]);
  if (!results[0].meta.changes) {
    const [mine, here] = await Promise.all([
      env.DB.prepare(`SELECT ${heldSql("t.host_id = ?1", "?2")} AS b`).bind(user.id, cut).first(),
      env.DB.prepare(`SELECT ${heldSql("t.id = ?1", "?2")} AS b`).bind(trip.id, cut).first(),
    ]);
    const have = Number(mine?.b) || 0, needs = Number(here?.b) || 0;
    if (have + needs > limit) {
      return json({
        error: "storage full", needed: needs, used: have, limit,
        reason: `This trip holds ${formatBytes(needs)} and you have ${formatBytes(Math.max(0, limit - have))} left of ${formatBytes(limit)}, so it doesn't fit. Free some space, or ask the host to make the trip smaller first.`,
      }, 413);
    }
    return err(409, "not handed over", { reason: "the trip or its people changed; read the trip again" });
  }
  return json({ trip: tripShape({ ...trip, host_id: user.id, updated_at: now, rev }), rev });
}

