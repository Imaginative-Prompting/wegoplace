// Guests: people on a trip who joined by its link with only a name (model §22).
//
// A guest is a full member of the trips they are on, but they have no passkey, no Google or GitHub and no email: their
// way in is the session on the phone they joined from (sessions.js: 180 days, renewed while used). One phone's guest is
// one person across every trip it joins by link. A guest can't host or make a trip, connect an AI app, buy the plan or
// keep an email; each of those answers guestRefused(). Adding a passkey or a sign-in turns the same person into an
// account (nowAnAccount, in the same write as the passkey or sign-in), with nothing moved.
//
// A guest on a lost or new phone gets back through the host: People → the guest → a link to sign in again (one use,
// REJOIN_LINK_HOURS), made here and used by POST /api/auth/link (link.js). Only while every trip the guest is on now is
// one this host hosts: a guest is one person across trips, and a link made by the host of one trip must never open
// another host's trip. Using it ends the guest's other sessions, so a lost phone is signed out.
//
//   POST /api/trips/<trip>/members/<user>/rejoin   -> 201 { url, expires_at }   host only; the member a guest
//
// The guest is stored (users.guest, migration 0040), never guessed from "no way to sign in": that link signs someone in
// on another person's say, and must never reach an account.

import { GUESTS_PER_ADDRESS_HOUR, GUESTS_PER_LINK_HOUR, REJOIN_LINK_HOURS, REJOIN_LINKS_PER_HOUR } from "../../public/js/shared/limits.js";
import { json } from "../api/json.js";
import { err } from "../api/trip.js";
import { hostOnly } from "../trips/access.js";
import { providersReady } from "./providers.js";
import { forgetUser } from "./sessions.js";
import { answer, connection, nowSec, randomId, sha256Hex } from "./util.js";

const HOUR = 3600;

/**
 * The ways in this site has set up, as words for a sentence: a passkey always, and Google and GitHub only where their
 * sign-in is set up (the same source /api/auth/config reads): the passkey alone, or the passkey with Google, GitHub or
 * both, the last joined by "or". `own` makes them someone's own ("their passkey…"). A sentence never names a way the site
 * hasn't got.
 */
export function waysIn(env, own = "") {
  const p = providersReady(env);
  const ways = [own ? `${own} passkey` : "a passkey", p.google && "Google", p.github && "GitHub"].filter(Boolean);
  return ways.length === 1 ? ways[0] : `${ways.slice(0, -1).join(", ")} or ${ways.at(-1)}`;
}

/** The answer to a guest asking for what only an account may do: `reason`, or that they add a way in first. */
export const guestRefused = (env, reason) => answer({
  error: "guest",
  reason: reason ?? `You're a guest. Add ${waysIn(env)} on your account page to do that.`,
}, 403);

/** Whether a user (ctx.data.user, from the session) is a guest. */
export const isGuest = (user) => !!user?.guest;

/**
 * The statement that makes a guest an account, to run in the same batch as the passkey or sign-in it adds. Call
 * forgetUser(userId) after it ran, so this isolate's remembered session doesn't call them a guest any more.
 */
export const nowAnAccountStatement = (env, userId) =>
  env.DB.prepare("UPDATE users SET guest = 0 WHERE id = ?1 AND guest = 1").bind(userId);

/** After a passkey or sign-in was added: the remembered sessions of this person read afresh. */
export const nowAnAccount = (userId) => forgetUser(userId);

// ── what is counted by the hour ─────────────────────────────────────────────────────────────

/** How many of `kind` for `key` in the last hour, and when the oldest of them goes out of it. */
async function hourCount(env, kind, key, now) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(at) AS first FROM hour_counts WHERE kind = ?1 AND key = ?2 AND at > ?3")
    .bind(kind, key, now - HOUR).first();
  return { n: row?.n ?? 0, wait: row?.first ? Math.max(60, row.first + HOUR - now) : HOUR };
}

/** The statement that counts one more of `kind` for `key`. */
export const countStatement = (env, kind, key, now) =>
  env.DB.prepare("INSERT INTO hour_counts (kind, key, at) VALUES (?1, ?2, ?3)").bind(kind, key, now);

const overHour = (reason, wait) => answer({ error: "too many", reason }, 429, [], { "Retry-After": String(wait) });

/** The address a request came from, as it is kept: a hash, never the address. */
export const addressKey = (request) => sha256Hex(`guest-address:${connection(request)}`);

/**
 * Whether one more guest may be made from this address by this link now; null when yes, else the 429 to answer. The
 * count is written by the join itself (links.js), in the batch that makes the guest, so only a guest made counts.
 */
export async function guestLimit(env, request, linkId, now = nowSec()) {
  const address = await hourCount(env, "guest-address", await addressKey(request), now);
  if (address.n >= GUESTS_PER_ADDRESS_HOUR) {
    return overHour(`${GUESTS_PER_ADDRESS_HOUR} people have joined from this connection in the last hour. Try again later, or sign in.`, address.wait);
  }
  const link = await hourCount(env, "guest-link", linkId, now);
  if (link.n >= GUESTS_PER_LINK_HOUR) {
    return overHour(`${GUESTS_PER_LINK_HOUR} people have joined by this link in the last hour. Try again later.`, link.wait);
  }
  return null;
}

// ── the host's link to sign a guest in again ────────────────────────────────────────────────

const decoded = (part) => { try { return decodeURIComponent(String(part ?? "")); } catch { return null; } };

/** The trips a guest is on now that `hostId` doesn't host: none, or the link may not be made. A SQL fragment over ?1 (guest) and ?2 (host). */
const ELSEWHERE = `SELECT COUNT(*) FROM trip_members m JOIN trips t ON t.id = m.trip_id
  WHERE m.user_id = ?1 AND m.left_at IS NULL AND t.host_id != ?2`;
/** Still a guest: the flag, and (whatever the flag says) no passkey and no sign-in. Over ?1 (the person). */
const STILL_GUEST = `u.guest = 1 AND u.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?1) AND NOT EXISTS (SELECT 1 FROM identities WHERE user_id = ?1)`;

export async function makeRejoinLink({ env, data, params }) {
  const { user, trip, host } = data;
  if (!host) return hostOnly();
  const target = decoded(params.user);
  const member = target && await env.DB.prepare(
    `SELECT u.guest, u.name FROM trip_members m JOIN users u ON u.id = m.user_id
     WHERE m.trip_id = ?1 AND m.user_id = ?2 AND m.left_at IS NULL AND u.deleted_at IS NULL`,
  ).bind(trip.id, target).first();
  if (!member) return err(404, "no such member", { id: String(params.user).slice(0, 64), reason: "Nobody on this trip has that id." });
  const guest = await env.DB.prepare(`SELECT 1 AS ok FROM users u WHERE u.id = ?1 AND ${STILL_GUEST}`).bind(target).first();
  if (!guest) {
    return err(409, "not a guest", { reason: `${member.name} has an account: they sign in on a new phone with ${waysIn(env, "their")}.` });
  }
  const elsewhere = await env.DB.prepare(`SELECT (${ELSEWHERE}) AS n`).bind(target, user.id).first();
  if ((elsewhere?.n ?? 0) > 0) {
    return err(409, "on another trip", {
      reason: `${member.name} is also on a trip someone else hosts, so a link from you can't sign them in. They can join this trip again by its link, or add ${waysIn(env)} while they still have their phone.`,
    });
  }
  const now = nowSec();
  const made = await hourCount(env, "rejoin-host", user.id, now);
  if (made.n >= REJOIN_LINKS_PER_HOUR) {
    return overHour(`That's ${REJOIN_LINKS_PER_HOUR} links to sign someone in again in an hour. Try again later.`, made.wait);
  }
  const token = randomId(32);
  const expiresAt = now + REJOIN_LINK_HOURS * HOUR;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO signin_links (token_hash, user_id, created_at, expires_at, made_by) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(await sha256Hex(token), target, now, expiresAt, user.id),
    countStatement(env, "rejoin-host", user.id, now),
  ]);
  return json({ url: `/login/link/${token}`, expires_at: expiresAt }, 201);
}

/**
 * Whether a host's link may still sign this guest in (it is checked again when used: they may have added a passkey, or
 * joined another host's trip, since it was made).
 */
export async function rejoinStillGood(env, guestId, hostId) {
  const row = await env.DB.prepare(
    `SELECT (${ELSEWHERE}) AS elsewhere, EXISTS (SELECT 1 FROM users u WHERE u.id = ?1 AND ${STILL_GUEST}) AS guest`,
  ).bind(guestId, hostId).first();
  return !!row?.guest && (row?.elsewhere ?? 1) === 0;
}
