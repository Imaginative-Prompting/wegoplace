// A session: an account signed in on one browser. The cookie holds a random token and the
// database holds only its sha256, so nothing read from the database signs anyone in.
//
// A session lasts 180 days from its last use: a trip app is opened every day for two weeks and
// then not for months, and nobody should be signed out between planning a trip and taking it.

import {
  clearCookieHeader, clearReadableCookieHeader, connection, cookieHeader, nowSec, randomId, readableCookieHeader, readCookie,
  sha256Hex,
} from "./util.js";
import { fromOldCookie, OLD_COOKIE } from "./old-cookie.js";

export const SESSION_COOKIE = "wgp_session";
export const SESSION_DAYS = 180;
const DAY = 86400;
const LIFE = SESSION_DAYS * DAY;

// WHO IS SIGNED IN, FOR THE PHONE. `wgp_who` holds the signed-in account's id and nothing
// else, readable by the page (not HttpOnly), set and cleared with the session cookie. The app
// keeps trips on the phone, and must know before it reads one whether they are this person's:
// it can't read the session cookie, and asking /api/me first would either show someone else's
// rows for a moment or stop it opening offline. So it compares this id with the one stored
// with the phone's data, and clears the phone when they differ.
//
// The server never trusts it: it decides nothing here. It is read in one place, the gate, and
// only to know whether a signed-in browser lacks it (or holds another account's), to send it
// again.
export const WHO_COOKIE = "wgp_who";
/** The Set-Cookie value that tells the page which account is signed in, for `seconds`. */
export const whoCookie = (userId, seconds) => readableCookieHeader(WHO_COOKIE, userId, seconds);
/** Every Set-Cookie value that leaves this browser signed out: the session, the old cookie, the account's id. */
export const signedOut = () => [clearCookieHeader(SESSION_COOKIE), clearCookieHeader(OLD_COOKIE), clearReadableCookieHeader(WHO_COOKIE)];

/** A connection past SESSION_LIMITER: the gate answers 429 before its cookie costs the database a read. */
export class SessionsLimited extends Error {
  constructor() { super("sessions limited"); }
}

// WHAT IS LIMITED, AND WHAT ISN'T. SESSION_LIMITER exists so that made-up cookies can't spend
// database reads without end: it counts, per connecting address, the cookies this isolate
// doesn't know. It must never count people for using the app. A group on one lodging's Wi-Fi is
// one address, and a minute of the map and the photos is hundreds of requests each. So:
//   * a session the database found in the last SESSION_CACHE_SECONDS isn't counted again. Its
//     requests still read the database every time (under /api, /media and /tiles); only the
//     count is skipped. Someone using the app costs the address one count when they start and
//     one after each pause longer than that;
//   * a cookie the database did not find is remembered as that, and answered from memory for
//     the same while: no count and no read. A token that isn't a session can't become one (a
//     session's token is made here, at random, when it starts), so this is never wrong for a
//     person. A row put into `sessions` by hand, for a token already tried, takes that while
//     to be seen;
//   * requests for one cookie that arrive together, before the first has its answer, share one
//     count (a cold start of the app sends some forty at once).
// What is left to count is a cookie nobody here has seen: one count each, 1,200 a minute.

// Each request is counted once, however many times its session is looked up.
const counted = new WeakMap();
// hash -> the count now being asked for it, while its first answer is on the way.
const asking = new Map();
async function mayLookUp(request, env, hash = null) {
  const seen = counted.get(request);
  if (seen !== undefined) return seen;
  const count = () => env.SESSION_LIMITER.limit({ key: `session:${connection(request)}` }).then((r) => r.success);
  let allowed;
  if (hash === null) allowed = await count();
  else {
    let shared = asking.get(hash);
    if (!shared) {
      shared = count();
      asking.set(hash, shared);
    }
    allowed = await shared;
  }
  counted.set(request, allowed);
  return allowed;
}

// Sessions the database found a moment ago, kept in this isolate. Two things use them: the
// requests that may be answered from them (`cached`: the app's own files, which are the same
// for everyone; a cold start of the app asks for some forty of them at once, and each would
// otherwise be a read), and the limit above. Keyed by the token's hash, never the token.
// Signing out and deleting an account drop theirs in this isolate; another isolate may answer
// one of those files for a signed-out cookie until its entry is SESSION_CACHE_SECONDS old.
// Everything under /api and /media reads the database every time. The map's tiles may be
// answered from here (one screen of map is dozens of requests), except that "on no trip" is
// never taken from here: someone who has just joined their first trip gets the map at once.
export const SESSION_CACHE_SECONDS = 30;
const SESSION_CACHE_MAX = 5000;
const recent = new Map();
function remember(hash, user, expiresAt, now) {
  recent.delete(hash);
  recent.set(hash, { user, expiresAt, at: now });
  while (recent.size > SESSION_CACHE_MAX) recent.delete(recent.keys().next().value);
}
export function forgetUser(userId) {
  for (const [hash, entry] of recent) if (entry.user.id === userId) recent.delete(hash);
}
// Cookies the database did not find: hash -> when. The same size and age as the ones it did.
const absent = new Map();
function rememberAbsent(hash, now) {
  absent.delete(hash);
  absent.set(hash, now);
  while (absent.size > SESSION_CACHE_MAX) absent.delete(absent.keys().next().value);
}

// `on_trip`: on some trip now. Only the map's tiles ask (src/tiles.js): they are the one thing
// of a trip that is not yet addressed through one. Every other trip route names its trip, and
// the route table checks the caller is on that one (src/trips/access.js).
const READ = `SELECT u.id, u.name, u.guest, s.expires_at,
    EXISTS (SELECT 1 FROM trip_members m WHERE m.user_id = u.id AND m.left_at IS NULL) AS on_trip
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.deleted_at IS NULL`;

/**
 * Who is signed in: { user: { id, name, onTrip, guest }, expiresAt, cookies } or null (`guest`: src/accounts/guests.js). `cookies` are
 * Set-Cookie values the caller must send back; only a caller that will passes `extend`, which
 * moves a session out to a full life again, and its cookie with it, once a day of that life has
 * been used: 180 days from its last use, for at most one write a day.
 */
export async function sessionOf(request, env, { extend = false, cached = false, now = nowSec() } = {}) {
  let token = readCookie(request, SESSION_COOKIE);
  const cookies = [];
  let bridged = false;
  if (!token && extend) {
    // No session, but perhaps the signed cookie from before sessions were kept here.
    if (!readCookie(request, OLD_COOKIE)) return null;
    if (!(await mayLookUp(request, env))) throw new SessionsLimited();
    token = await fromOldCookie(request, env, { now, life: LIFE });
    if (!token) return null;
    cookies.push(cookieHeader(SESSION_COOKIE, token, LIFE), clearCookieHeader(OLD_COOKIE));
    bridged = true;      // (the account's id follows below, once the session's row is read)
  }
  if (!token) return null;
  const hash = await sha256Hex(token);
  // The old cookie's session has the same token every time it is made, so it can come back
  // after being signed out: what was remembered about its absence no longer holds.
  if (bridged) absent.delete(hash);
  const kept = recent.get(hash);
  const known = !!kept && now - kept.at < SESSION_CACHE_SECONDS && kept.expiresAt > now;
  if (cached && known && kept.user.onTrip && !bridged) return { user: kept.user, expiresAt: kept.expiresAt, cookies };
  try {
    if (!known) {
      const missed = absent.get(hash);
      if (missed !== undefined && now - missed < SESSION_CACHE_SECONDS) return null;
      if (!(await mayLookUp(request, env, hash))) throw new SessionsLimited();
    }
    const row = await env.DB.prepare(READ).bind(hash, now).first();
    if (!row) {
      recent.delete(hash);
      rememberAbsent(hash, now);
      return null;
    }
    const user = { id: row.id, name: row.name, onTrip: !!row.on_trip, guest: !!row.guest };
    let expiresAt = row.expires_at;
    if (extend && expiresAt - now < LIFE - DAY) {
      expiresAt = now + LIFE;
      await env.DB.prepare("UPDATE sessions SET expires_at = ?1 WHERE token_hash = ?2").bind(expiresAt, hash).run();
      cookies.push(cookieHeader(SESSION_COOKIE, token, LIFE), whoCookie(user.id, LIFE));
    } else if (bridged) {
      cookies.push(whoCookie(user.id, expiresAt - now));
    }
    remember(hash, user, expiresAt, now);
    return { user, expiresAt, cookies };
  } finally {
    // Whatever came of it, the next cookie like this one is asked about afresh.
    asking.delete(hash);
  }
}

/** Starts a session for an account and returns its Set-Cookie values: the session, and the account's id for the page. */
export async function startSession(env, userId, request, now = nowSec()) {
  const token = randomId(32);
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(await sha256Hex(token), userId, now, now + LIFE, request.headers.get("User-Agent")?.slice(0, 200) ?? null)
    .run();
  return [cookieHeader(SESSION_COOKIE, token, LIFE), whoCookie(userId, LIFE)];
}

/** Ends this browser's session. Returns the Set-Cookie values that clear it (the old cookie too, so it can't bring one back, and the account's id). */
export async function endSession(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) {
    const hash = await sha256Hex(token);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(hash).run();
    recent.delete(hash);
    rememberAbsent(hash, nowSec());
  }
  return signedOut();
}

/** The statements that end every session of an account, on every browser, the old cookie's included. */
export function endAllSessions(env, userId) {
  forgetUser(userId);
  return [
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId),
    env.DB.prepare("DELETE FROM old_cookie_accounts WHERE user_id = ?1").bind(userId),
  ];
}
