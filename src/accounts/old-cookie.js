// The sign-in cookie from before sessions were kept in the database: s2=<account>.<expiry>.<hmac>,
// signed with AUTH_SECRET, good for 180 days from when it was set and impossible to take back
// one at a time. A browser that still holds one is given a real session in its place the first
// time it shows up, and the old cookie is cleared, so nobody who was signed in has to sign in
// again because the site changed how it remembers them.
//
// Only an account that existed then can do this (the table old_cookie_accounts, filled by
// migration 0016), and "sign out everywhere" or deleting the account takes it off that list:
// the old cookie itself can't be revoked, the account's use of it can.
//
// A deployment that never had those cookies has an empty table and no AUTH_SECRET, and this
// file does nothing. Where it did, the last such cookie runs out 180 days after the day the
// site moved to sessions; after that this file and the table can go.

import { hmacHex, readCookie, secretsEqual, sha256Hex } from "./util.js";

export const OLD_COOKIE = "s2";

/**
 * The token of the session that stands in for this request's old cookie, made if it isn't there
 * yet; null when the cookie isn't a good one or its account may not use it. The token is derived
 * from the cookie and the secret, so the forty requests an app start sends at once all get the
 * same session instead of forty.
 */
export async function fromOldCookie(request, env, { now, life }) {
  const value = readCookie(request, OLD_COOKIE);
  if (!value || !env.AUTH_SECRET) return null;
  const [userId, expires, signature, ...more] = value.split(".");
  if (!userId || !signature || more.length || !/^\d{1,12}$/.test(expires ?? "") || Number(expires) < now) return null;
  if (!(await secretsEqual(await hmacHex(env.AUTH_SECRET, `${userId}.${expires}`), signature))) return null;
  const token = await hmacHex(env.AUTH_SECRET, `session for the old cookie\n${value}`);
  // Made only for an account still on the list; a session already there is left as it is.
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent)
     SELECT ?1, o.user_id, ?2, ?3, ?4 FROM old_cookie_accounts o JOIN users u ON u.id = o.user_id
     WHERE o.user_id = ?5 AND u.deleted_at IS NULL
     ON CONFLICT (token_hash) DO NOTHING`,
  ).bind(await sha256Hex(token), now, now + life, request.headers.get("User-Agent")?.slice(0, 200) ?? null, userId).run();
  return token;
}
