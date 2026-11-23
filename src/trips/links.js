// The links people join a trip by.
//
// Under /api/trips/<trip>/ (the route table checks the caller is on the trip):
//   POST   links  { days?, uses? }  -> { link, rev }   201; any member. `link.code` and
//                                                       `link.url` are given here and never again
//   GET    links                    -> { links }       any member; no codes
//   DELETE links/<id>               -> { ok, revoked, rev }   host only
//
// And, with no trip in the address, because whoever holds a link is not on the trip yet:
//   GET    /api/join/<code>         -> { trip: { name, starts_on, ends_on }, host: { name } }
//                                      anyone, signed in or not: what the join page shows
//   POST   /api/join/<code>         -> { trip, joined, rev, guest }   signed in: puts that person on the trip.
//                                      Signed out, with { name }: makes a guest of that name on this phone (a session,
//                                      no way to sign in elsewhere; src/accounts/guests.js) and puts them on it, or
//                                      nobody is made. 400 { error: "name" }; 503 while sign-ups are paused; 429 past
//                                      the guests an address or a link may make in an hour
//
// A link is a code with an end: it expires, it can put only so many people on the trip, and
// the host can revoke it. A link that has ended in any of those ways answers exactly as a
// code that never existed, so nobody learns from the answer that a link once worked.
//
// Only a hash of the code is kept. The code is shown once, to the person who made the link;
// the database, a backup of it, or a list of a trip's links can't be turned into a way in.

import {
  LINK_DAYS_DEFAULT, LINK_DAYS_MAX, LINK_USES_DEFAULT, LINK_USES_MAX, LINKS_LIVE_MAX, TRIP_MEMBERS_MAX,
} from "../../public/js/shared/limits.js";
import { answer, cleanName, limited, newAccountId, randomId, sha256Hex, tooMany } from "../accounts/util.js";
import { addressKey, guestLimit } from "../accounts/guests.js";
import { startSession } from "../accounts/sessions.js";
import { signupsOpen, signupsPaused } from "../accounts/signups.js";
import { json, readJson } from "../api/json.js";
import { colourFor, colourForNew, err, nowSec } from "../api/trip.js";
import { hostOnly, tripShape } from "./access.js";
import { REV, bump, moved, write } from "./rev.js";

const DAY = 86400;
// What a code looks like: 16 random bytes, url-safe. Anything else isn't asked about.
const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
export const noSuchLink = () => json({ error: "no such link", reason: "This link doesn't work. It may have run out, been used by as many people as it allows, or been turned off. Ask someone on the trip for a new one." }, 404);
// A link that can still put someone on its trip, as of ?now.
const LIVE = (now) => `revoked_at IS NULL AND expires_at > ${now} AND uses < max_uses`;

const linkShape = (r, now) => ({
  id: r.id, created_by: r.created_by, created_at: r.created_at, expires_at: r.expires_at,
  max_uses: r.max_uses, uses: r.uses, revoked_at: r.revoked_at ?? null,
  live: r.revoked_at === null && r.expires_at > now && r.uses < r.max_uses, rev: r.rev,
});

/** A whole number from `lo` to `hi`, or the default when absent, or null when it is neither. */
function count(value, fallback, lo, hi) {
  if (value === undefined || value === null) return fallback;
  return Number.isInteger(value) && value >= lo && value <= hi ? value : null;
}

// ── POST links ─────────────────────────────────────────────────────────────────────────────
export async function createLink({ request, env, data }) {
  const { user, trip } = data;
  const b = await readJson(request);
  const days = count(b.days, LINK_DAYS_DEFAULT, 1, LINK_DAYS_MAX);
  if (days === null) return err(400, "bad days", { need: `a whole number from 1 to ${LINK_DAYS_MAX}`, reason: `A link works for 1 to ${LINK_DAYS_MAX} days.` });
  const uses = count(b.uses, LINK_USES_DEFAULT, 1, LINK_USES_MAX);
  if (uses === null) return err(400, "bad uses", { need: `a whole number from 1 to ${LINK_USES_MAX}`, reason: `A link lets 1 to ${LINK_USES_MAX} people join.` });

  const now = nowSec();
  const id = crypto.randomUUID();
  const code = randomId(16);
  const expires = now + days * DAY;
  // Counted first, so a trip at its most writes nothing (not even its rev); and inside the insert too, so two links
  // made at once can't both pass it.
  const live = await env.DB.prepare(`SELECT COUNT(*) AS n FROM trip_links WHERE trip_id = ?1 AND ${LIVE("?2")}`).bind(trip.id, now).first();
  if ((live?.n ?? 0) >= LINKS_LIVE_MAX) {
    return err(409, "too many links", { max: LINKS_LIVE_MAX, reason: `a trip can have ${LINKS_LIVE_MAX} links in use at once; the host can revoke one` });
  }
  // The count is inside the insert, so two links made at once can't both pass it.
  const { rev, results } = await write(env, trip.id, [
    env.DB.prepare(
      `INSERT INTO trip_links (id, trip_id, code_hash, created_by, created_at, expires_at, max_uses, rev, created_rev)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ${REV(2)}, ${REV(2)}
       WHERE (SELECT COUNT(*) FROM trip_links WHERE trip_id = ?2 AND ${LIVE("?5")}) < ?8`,
    ).bind(id, trip.id, await sha256Hex(code), user.id, now, expires, uses, LINKS_LIVE_MAX),
  ]);
  if (!results[0].meta.changes) {
    return err(409, "too many links", { max: LINKS_LIVE_MAX, reason: `a trip can have ${LINKS_LIVE_MAX} links in use at once; the host can revoke one` });
  }
  return json({
    link: {
      id, code, url: `/join/${code}`, created_by: user.id, created_at: now, expires_at: expires,
      max_uses: uses, uses: 0, revoked_at: null, live: true, rev,
    },
    rev,
  }, 201);
}

// ── GET links ──────────────────────────────────────────────────────────────────────────────
// The newest hundred, ended ones included: who made a link and how many people came by it is
// worth seeing after it has ended.
export async function listLinks({ env, data }) {
  return json({ links: await linkRows(env, data.trip.id) });
}

/** The trip's links as GET links answers them (also in GET people). */
export async function linkRows(env, tripId, now = nowSec()) {
  const rows = await env.DB.prepare(
    `SELECT id, created_by, created_at, expires_at, max_uses, uses, revoked_at, rev FROM trip_links
     WHERE trip_id = ?1 ORDER BY created_at DESC, id LIMIT 100`,
  ).bind(tripId).all();
  return (rows.results || []).map((r) => linkShape(r, now));
}

// ── DELETE links/<id> ──────────────────────────────────────────────────────────────────────
// Already revoked, or never there, is success: a revoke sent twice must not become an error.
export async function revokeLink({ env, data, params }) {
  const { trip, host } = data;
  if (!host) return hostOnly();
  let id;
  try { id = decodeURIComponent(String(params.id ?? "")); } catch { id = ""; }
  const there = id && await env.DB.prepare(
    "SELECT 1 AS ok FROM trip_links WHERE id = ?1 AND trip_id = ?2 AND revoked_at IS NULL",
  ).bind(id, trip.id).first();
  if (!there) return json({ ok: true, revoked: false, rev: trip.rev });
  const { rev } = await write(env, trip.id, [
    env.DB.prepare(
      `UPDATE trip_links SET revoked_at = ?3, rev = ${REV(2)} WHERE id = ?1 AND trip_id = ?2 AND revoked_at IS NULL`,
    ).bind(id, trip.id, nowSec()),
  ]);
  return json({ ok: true, revoked: true, rev });
}

// ── /api/join/<code> ───────────────────────────────────────────────────────────────────────

/** The link a code names if it can still put someone on its trip, with the trip; else null. */
async function liveLink(env, code, now) {
  if (typeof code !== "string" || !CODE_RE.test(code)) return null;
  return env.DB.prepare(
    `SELECT l.id AS link_id, l.created_rev AS link_rev, t.id, t.name, t.starts_on, t.ends_on, t.default_tz, t.currencies, t.collage_seed,
       t.collage_version, t.host_id, t.created_by, t.created_at, t.updated_at, t.rev, t.interests, t.tiles, h.name AS host_name
     FROM trip_links l JOIN trips t ON t.id = l.trip_id LEFT JOIN users h ON h.id = t.host_id
     WHERE l.code_hash = ?1 AND l.revoked_at IS NULL AND l.expires_at > ?2 AND l.uses < l.max_uses`,
  ).bind(await sha256Hex(code), now).first();
}

// Guessing codes is what this limit is for; a code is 128 random bits, so the limit is about
// load, not about being found.
export async function viewJoin({ request, env, params }) {
  if (await limited(env.AUTH_LIMITER, "join", request)) return tooMany();
  const link = await liveLink(env, params.code, nowSec());
  if (!link) return noSuchLink();
  // The least that lets someone know they're joining the right thing. Nothing else of the
  // trip is anyone's to see before they are on it.
  return json({
    trip: { name: link.name, starts_on: link.starts_on || null, ends_on: link.ends_on || null },
    host: { name: link.host_name || "" },
  });
}

export async function join({ request, env, data, params }) {
  const signedIn = data.user ?? null;
  if (await limited(env.AUTH_LIMITER, "join", request)) return tooMany();
  // Signed out: a guest, by the name they gave (checked before the link, so a bad name costs no read).
  let name = null;
  if (!signedIn) {
    name = cleanName((await readJson(request))?.name);
    if (!name) return answer({ error: "name", reason: "Say your name, as the people on the trip will see it: 1 to 40 characters." }, 400);
    if (!signupsOpen(env)) return signupsPaused();
  }
  const now = nowSec();
  const link = await liveLink(env, params.code, now);
  if (!link) return noSuchLink();
  const tripId = link.id;

  if (signedIn) {
    // Already on it: nothing to do, and the link keeps the use for someone else.
    const seat = await env.DB.prepare("SELECT left_at, removed_rev FROM trip_members WHERE trip_id = ?1 AND user_id = ?2")
      .bind(tripId, signedIn.id).first();
    if (seat && seat.left_at === null) return json({ trip: tripShape(link), joined: false, rev: link.rev, guest: !!signedIn.guest });
    // Removed by the host: only a link made after that brings them back (migration 0018). To
    // them, an older link is a link that doesn't work, in the same words.
    if (seat && seat.removed_rev !== null && !(link.link_rev > seat.removed_rev)) return noSuchLink();
  } else {
    const over = await guestLimit(env, request, link.link_id, now);
    if (over) return over;
  }
  const userId = signedIn ? signedIn.id : newAccountId();

  // One transaction. The member row is written only while the link is still good and the trip
  // has room; the link's use is counted only if that row was written in this same batch (it
  // carries the rev this batch made, which no other write can have). So a link's last use
  // can't be taken twice, and a use is never spent without someone joining.
  //
  // Someone who was on the trip before comes back onto the row they had, with the day they
  // first joined; someone the host removed, only by a link made after the removal (checked
  // again here, in case the removal landed after the look above).
  //
  // A guest's row is made in the same batch, under the same two conditions, so a link that ended or a trip that filled
  // makes nobody; what an address and a link have made this hour is counted only when the guest joined.
  const linkLive = `EXISTS (SELECT 1 FROM trip_links WHERE id = ?4 AND ${LIVE("?3")})`;
  const room = `(SELECT COUNT(*) FROM trip_members WHERE trip_id = ?1 AND left_at IS NULL) < ?5`;
  const joinedNow = `EXISTS (SELECT 1 FROM trip_members WHERE trip_id = ?1 AND user_id = ?2 AND left_at IS NULL AND rev = ${REV(1)})`;
  // Their colour on notes, if they have none yet, in this same write and only if they joined:
  // reading the trip afterwards writes nothing.
  const colour = signedIn ? await colourFor(env, tripId, userId) : await colourForNew(env, tripId, userId);
  const statements = [bump(env, tripId)];
  if (!signedIn) {
    statements.push(env.DB.prepare(
      `INSERT INTO users (id, name, created_at, guest, note_color) SELECT ?2, ?6, ?3, 1, ?7 WHERE ${linkLive} AND ${room}`,
    ).bind(tripId, userId, now, link.link_id, TRIP_MEMBERS_MAX, name, colour ?? null));
  }
  const memberAt = statements.length;
  statements.push(
    env.DB.prepare(
      `INSERT INTO trip_members (trip_id, user_id, joined_at, rev)
       SELECT ?1, ?2, ?3, ${REV(1)}
       WHERE ${linkLive} AND ${room} AND EXISTS (SELECT 1 FROM users WHERE id = ?2)
       ON CONFLICT(trip_id, user_id) DO UPDATE SET left_at = NULL, removed_rev = NULL, rev = excluded.rev
         WHERE trip_members.left_at IS NOT NULL
           AND (trip_members.removed_rev IS NULL
                OR trip_members.removed_rev < (SELECT created_rev FROM trip_links WHERE id = ?4))`,
    ).bind(tripId, userId, now, link.link_id, TRIP_MEMBERS_MAX),
    env.DB.prepare(
      `UPDATE trip_links SET uses = uses + 1, rev = ${REV(1)}
       WHERE id = ?4 AND ${LIVE("?3")} AND ${joinedNow}`,
    ).bind(tripId, userId, now, link.link_id),
  );
  if (signedIn && colour) {
    statements.push(env.DB.prepare(
      `UPDATE users SET note_color = ?1 WHERE id = ?2 AND note_color IS NULL
         AND EXISTS (SELECT 1 FROM trip_members WHERE trip_id = ?3 AND user_id = ?2 AND left_at IS NULL AND rev = ${REV(3)})`,
    ).bind(colour, userId, tripId));
  }
  if (!signedIn) {
    const address = await addressKey(request);
    for (const [kind, key] of [["guest-address", address], ["guest-link", link.link_id]]) {
      statements.push(env.DB.prepare(
        `INSERT INTO hour_counts (kind, key, at) SELECT ?6, ?7, ?3 WHERE ${joinedNow}`,
      ).bind(tripId, userId, now, link.link_id, TRIP_MEMBERS_MAX, kind, key));
    }
  }
  const results = await env.DB.batch(statements);
  const bumped = results[0];
  const counted = results[memberAt + 1];
  await moved(env, tripId, bumped.results[0]?.rev ?? null);
  if (!counted.meta.changes) {
    // Nobody joined: a guest's row made in the batch (the link ended between its look and the member's) goes again.
    if (!signedIn) {
      await env.DB.prepare("DELETE FROM users WHERE id = ?1 AND guest = 1 AND NOT EXISTS (SELECT 1 FROM trip_members WHERE user_id = ?1)")
        .bind(userId).run();
    }
    const people = await env.DB.prepare("SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = ?1 AND left_at IS NULL")
      .bind(tripId).first();
    if ((people?.n ?? 0) >= TRIP_MEMBERS_MAX) {
      return err(409, "trip is full", { max: TRIP_MEMBERS_MAX, reason: `a trip can have ${TRIP_MEMBERS_MAX} people on it at a time` });
    }
    // The link ended between the look and the write.
    return noSuchLink();
  }

  const rev = bumped.results[0]?.rev ?? null;
  const body = { trip: tripShape({ ...link, rev }), joined: true, rev, guest: signedIn ? !!signedIn.guest : true };
  if (signedIn) return json(body);
  console.log("wgp-watch guest");
  return answer(body, 200, await startSession(env, userId, request, now));
}
