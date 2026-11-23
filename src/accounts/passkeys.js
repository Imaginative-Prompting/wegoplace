// Passkeys: making an account with one, signing in with one, adding another to an account.
//
// Each ceremony is two calls. The first hands the browser a challenge and keeps it here for
// five minutes under a cookie; the second brings the device's answer and takes the challenge,
// once. The checking is @simplewebauthn/server's.
//
//   POST /api/auth/register/options  { name }            -> creation options      (anyone)
//   POST /api/auth/register/verify   <the device's answer> -> { ok, user }, signed in
//   POST /api/auth/login/options     { username? }        -> request options       (anyone)
//   POST /api/auth/login/verify      <the device's answer> -> { ok, user }, signed in
//   POST /api/auth/passkeys/options  {}                   -> creation options      (signed in)
//   POST /api/auth/passkeys/verify   <the device's answer> -> { ok }
//
// An error is { error: <a few fixed words> }; the pages hold the sentences.

import { nowAnAccount, nowAnAccountStatement } from "./guests.js";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { keep, take } from "./challenges.js";
import { startSession } from "./sessions.js";
import { signupsOpen, signupsPaused } from "./signups.js";
import {
  answer, base64UrlToBytes, bytesToBase64Url, cleanName, clearCookieHeader, cookieHeader, limited, newAccountId, nowSec,
  ownOrigin, readCookie, readObject, tooMany,
} from "./util.js";

const CHALLENGE_COOKIE = "wgp_chal";
const CHALLENGE_SECONDS = 300;
const clearChallenge = clearCookieHeader(CHALLENGE_COOKIE);
const fail = (error, status = 400) => answer({ error }, status, [clearChallenge]);

const utf8 = (text) => new TextEncoder().encode(text);
const transportsOf = (text) => { try { return JSON.parse(text ?? "[]") ?? []; } catch { return []; } };

async function challengeCookie(env, challenge, kind, userId, userName) {
  const id = await keep(env, { kind, value: challenge, userId, userName, seconds: CHALLENGE_SECONDS });
  return cookieHeader(CHALLENGE_COOKIE, id, CHALLENGE_SECONDS);
}

// What a new passkey is asked to be. residentKey "required": the device keeps the account with
// the passkey, so signing in never needs a name typed. userVerification "preferred": a device
// that can ask for a face, a finger or a PIN does, and one that can't still works.
const creation = (env, user, extra = {}) => generateRegistrationOptions({
  rpName: env.RP_NAME,
  rpID: env.RP_ID,
  userName: user.name,
  userDisplayName: user.name,
  userID: utf8(user.id),
  attestationType: "none",
  authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  timeout: CHALLENGE_SECONDS * 1000,
  ...extra,
});

const insertPasskey = (env, userId, info, now) => env.DB.prepare(
  `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, created_at, last_used_at)
   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
).bind(
  info.credential.id, userId, bytesToBase64Url(info.credential.publicKey), info.credential.counter,
  JSON.stringify(info.credential.transports ?? []), info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, now,
);

/** The device's answer to a creation, checked against the challenge this browser was given. Null when it doesn't check out. */
async function checkedCreation(env, request, response, challenge) {
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    // The page's own address, the one this answer came to (www's page at www): a passkey works at
    // every address of the site (RP_ID is the name they share), each answer only where it was made.
    expectedOrigin: ownOrigin(request, env),
    expectedRPID: env.RP_ID,
    requireUserVerification: false,
  }).catch(() => null);
  return result?.verified ? result.registrationInfo : null;
}

// ── a new account ──────────────────────────────────────────────────────────────────────────

export async function registerOptions({ request, env }) {
  // New accounts paused: refused before the device is asked for a passkey, with nothing written.
  if (!signupsOpen(env)) return signupsPaused();
  if (await limited(env.AUTH_LIMITER, "auth", request)) return tooMany([clearChallenge]);
  const name = cleanName((await readObject(request))?.name);
  if (!name) return fail("name");
  const user = { id: newAccountId(), name };
  const options = await creation(env, user);
  return answer(options, 200, [await challengeCookie(env, options.challenge, "register", user.id, user.name)]);
}

// Never refused for the pause: a challenge from before it already made a passkey on the
// person's device, and refusing would leave them one for an account that doesn't exist.
export async function registerVerify({ request, env }) {
  if (await limited(env.AUTH_LIMITER, "verify", request)) return tooMany([clearChallenge]);
  const pending = await take(env, readCookie(request, CHALLENGE_COOKIE), "register");
  if (!pending?.user_id || !pending.user_name) return fail("expired");
  const response = await readObject(request);
  if (!response) return fail("malformed");
  const info = await checkedCreation(env, request, response, pending.challenge);
  if (!info) return fail("not verified");
  const now = nowSec();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES (?1, ?2, ?3)").bind(pending.user_id, pending.user_name, now),
      insertPasskey(env, pending.user_id, info, now),
    ]);
  } catch {
    // The passkey is already some account's. The two inserts are one transaction: no account was made.
    return fail("already registered", 409);
  }
  console.log("wgp-watch signup");
  const user = { id: pending.user_id, name: pending.user_name };
  return answer({ ok: true, user }, 200, [clearChallenge, ...(await startSession(env, user.id, request, now))]);
}

// ── signing in ─────────────────────────────────────────────────────────────────────────────

// With no username the device offers the passkeys it holds for this site. An account from
// before open sign-up may have a passkey its device can't find that way (it was asked to keep
// the account with the key, not made to), so those accounts can still give their username, and
// the options then name their passkeys. Accounts made since have no username.
export async function loginOptions({ request, env }) {
  if (await limited(env.AUTH_LIMITER, "auth", request)) return tooMany([clearChallenge]);
  const body = await readObject(request);
  const username = typeof body?.username === "string" ? body.username.trim().toLowerCase().slice(0, 64) : "";
  let allowCredentials;
  if (username) {
    const rows = await env.DB.prepare(
      "SELECT p.id, p.transports FROM passkeys p JOIN users u ON u.id = p.user_id WHERE u.username = ?1 AND u.deleted_at IS NULL",
    ).bind(username).all();
    if (!rows.results.length) return fail("unknown username", 404);
    allowCredentials = rows.results.map((p) => ({ id: p.id, transports: transportsOf(p.transports) }));
  }
  const options = await generateAuthenticationOptions({
    rpID: env.RP_ID, userVerification: "preferred", allowCredentials, timeout: CHALLENGE_SECONDS * 1000,
  });
  return answer(options, 200, [await challengeCookie(env, options.challenge, "login", null, null)]);
}

export async function loginVerify({ request, env }) {
  if (await limited(env.AUTH_LIMITER, "verify", request)) return tooMany([clearChallenge]);
  const pending = await take(env, readCookie(request, CHALLENGE_COOKIE), "login");
  if (!pending) return fail("expired");
  const response = await readObject(request);
  if (typeof response?.id !== "string") return fail("malformed");
  const passkey = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.public_key, p.counter, p.transports, u.name
     FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id = ?1 AND u.deleted_at IS NULL`,
  ).bind(response.id).first();
  if (!passkey) return fail("unknown passkey", 401);
  // A passkey that keeps its account says whose it is; it must be the account it is filed under.
  const handle = response.response?.userHandle;
  if (handle && handle !== bytesToBase64Url(utf8(passkey.user_id))) return fail("not verified", 401);
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: pending.challenge,
    // The page's own address, the one this answer came to (www's page at www): a passkey works at
    // every address of the site (RP_ID is the name they share), each answer only where it was made.
    expectedOrigin: ownOrigin(request, env),
    expectedRPID: env.RP_ID,
    credential: {
      id: passkey.id,
      publicKey: base64UrlToBytes(passkey.public_key),
      counter: passkey.counter,
      transports: transportsOf(passkey.transports),
    },
    requireUserVerification: false,
  }).catch(() => null);
  if (!result?.verified) return fail("not verified", 401);
  const now = nowSec();
  const info = result.authenticationInfo;
  await env.DB.prepare("UPDATE passkeys SET counter = ?1, last_used_at = ?2, device_type = ?3, backed_up = ?4 WHERE id = ?5")
    .bind(info.newCounter, now, info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, passkey.id).run();
  const user = { id: passkey.user_id, name: passkey.name };
  return answer({ ok: true, user }, 200, [clearChallenge, ...(await startSession(env, user.id, request, now))]);
}

// ── another passkey on the account that is signed in ───────────────────────────────────────

export async function passkeysOptions({ request, env, data }) {
  // Each asks a challenge of the database: the same tries a connection has for signing in.
  if (await limited(env.AUTH_LIMITER, "auth", request)) return tooMany([clearChallenge]);
  const user = data.user;
  const existing = await env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?1").bind(user.id).all();
  const options = await creation(env, user, {
    // A device that already holds one for this account says so instead of making a second.
    excludeCredentials: existing.results.map((p) => ({ id: p.id, transports: transportsOf(p.transports) })),
  });
  return answer(options, 200, [await challengeCookie(env, options.challenge, "add-passkey", user.id, user.name)]);
}

export async function passkeysVerify({ request, env, data }) {
  if (await limited(env.AUTH_LIMITER, "verify", request)) return tooMany([clearChallenge]);
  const user = data.user;
  const pending = await take(env, readCookie(request, CHALLENGE_COOKIE), "add-passkey");
  if (!pending || pending.user_id !== user.id) return fail("expired");
  const response = await readObject(request);
  if (!response) return fail("malformed");
  const info = await checkedCreation(env, request, response, pending.challenge);
  if (!info) return fail("not verified");
  try {
    // A guest's first passkey makes them an account, in the same write (src/accounts/guests.js).
    await env.DB.batch([insertPasskey(env, user.id, info, nowSec()), nowAnAccountStatement(env, user.id)]);
  } catch {
    return fail("already registered", 409);
  }
  nowAnAccount(user.id);
  return answer({ ok: true }, 200, [clearChallenge]);
}
