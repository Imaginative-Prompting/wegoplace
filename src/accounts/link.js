// The way back by hand: a one-use link the site's operator makes for someone who has lost every
// way to sign in and has no email on the account (tools/signin-link.mjs makes one; only the
// token's sha256 is ever stored). A trip's host makes the same kind of link for a guest on a
// new phone (src/accounts/guests.js, `made_by`): it is checked again here (still a guest, on
// no trip another host hosts), and using it signs the guest's other phones out.
//
// Opening the link shows the sign-in page with one button, and the button is what uses it: a
// messaging app that fetches the address to draw a preview takes nothing. The button signs that
// one account in, once, and the account page then offers a passkey for this device.
//
//   GET  /login/link/<token>    the sign-in page
//   POST /api/auth/link         { token } -> { ok, user }, signed in

import { rejoinStillGood } from "./guests.js";
import { endAllSessions, startSession } from "./sessions.js";
import { answer, limited, nowSec, readObject, sameOrigin, sha256Hex, tooMany } from "./util.js";

export async function useLink({ request, env }) {
  if (!sameOrigin(request, env)) return answer({ error: "cross site" }, 403);
  if (await limited(env.AUTH_LIMITER, "verify", request)) return tooMany();
  const token = (await readObject(request))?.token;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) return answer({ error: "expired" }, 400);
  const now = nowSec();
  // Taken in the same statement that reads it, so it can't be used twice.
  const link = await env.DB.prepare("DELETE FROM signin_links WHERE token_hash = ?1 RETURNING user_id, expires_at, made_by")
    .bind(await sha256Hex(token)).first();
  if (!link || link.expires_at <= now) return answer({ error: "expired" }, 400);
  const user = await env.DB.prepare("SELECT id, name FROM users WHERE id = ?1 AND deleted_at IS NULL").bind(link.user_id).first();
  if (!user) return answer({ error: "expired" }, 400);
  if (link.made_by) {
    if (!(await rejoinStillGood(env, user.id, link.made_by))) return answer({ error: "expired" }, 400);
    await env.DB.batch(endAllSessions(env, user.id));
  }
  return answer({ ok: true, user: { id: user.id, name: user.name } }, 200, await startSession(env, user.id, request, now));
}
