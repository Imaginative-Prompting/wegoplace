// The account's own routes: what the sign-in page can offer, signing out, the ways an account
// signs in, and deleting it.
//
//   GET    /api/auth/config                   what this site offers, and its address (anyone)
//   POST   /api/auth/logout                   sign out of this browser (anyone)
//   POST   /api/auth/logout/all               sign out everywhere
//   GET    /api/auth/ways                     this account's passkeys and Google/GitHub sign-ins
//   DELETE /api/auth/ways/passkey/<id>        remove a passkey
//   DELETE /api/auth/ways/<provider>/<subject>  remove a Google or GitHub sign-in
//   DELETE /api/me   { confirm: "delete" }    delete the account; 409 { error: "host", trips }
//                                             while it hosts a trip other people are on

import { revokeAll } from "../mcp/oauth.js";
import { HostsTrips, deleteAccount } from "./delete.js";
import { BillingError } from "../billing/plan.js";
import { emailOffered } from "./email.js";
import { isProvider, providersReady } from "./providers.js";
import { endAllSessions, endSession, sessionOf, signedOut } from "./sessions.js";
import { signupsOpen } from "./signups.js";
import { answer, readObject } from "./util.js";
import { leaveRooms, sessionHash } from "../trips/live.js";

export function config({ env }) {
  return answer({
    name: env.RP_NAME,
    // The site's address for anything printed for someone else to use (an AI app's address, a
    // join link, a shared board), whichever of its addresses this page is at (www too).
    origin: env.PUBLIC_ORIGIN,
    providers: providersReady(env),
    signups: signupsOpen(env) ? "open" : "paused",
    email: emailOffered(env),
  });
}

export async function logout({ request, env }) {
  // This browser's sockets leave the trips' rooms with its session; other devices stay. The
  // address is open to anyone (the gate doesn't look the session up here), so it is read here.
  const session = await sessionHash(request);
  const found = session ? await sessionOf(request, env).catch(() => null) : null;
  const cookies = await endSession(request, env);
  if (found) await leaveRooms(env, found.user.id, { session });
  return answer({ ok: true }, 200, cookies);
}

export async function logoutAll({ env, data }) {
  await env.DB.batch([
    ...endAllSessions(env, data.user.id),
    // Signed out everywhere: no phone of this account is told of new messages any more.
    env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1").bind(data.user.id),
  ]);
  await leaveRooms(env, data.user.id);
  return answer({ ok: true }, 200, signedOut());
}

// ── the ways an account signs in ───────────────────────────────────────────────────────────

export async function ways({ env, data }) {
  const id = data.user.id;
  const [passkeys, identities, account] = await env.DB.batch([
    env.DB.prepare("SELECT id, backed_up, created_at, last_used_at FROM passkeys WHERE user_id = ?1 ORDER BY created_at").bind(id),
    env.DB.prepare("SELECT provider, subject, label, created_at, last_used_at FROM identities WHERE user_id = ?1 ORDER BY created_at").bind(id),
    env.DB.prepare("SELECT username, guest FROM users WHERE id = ?1").bind(id),
  ]);
  return answer({
    passkeys: passkeys.results.map((p) => ({
      id: p.id,
      // Whether the passkey is kept in a synced store (iCloud Keychain, Google Password Manager,
      // a password manager), so it's on the person's other devices too; null when not recorded.
      synced: p.backed_up === null ? null : !!p.backed_up,
      createdAt: p.created_at,
      lastUsedAt: p.last_used_at,
    })),
    identities: identities.results.map((i) => ({
      provider: i.provider, subject: i.subject, label: i.label, createdAt: i.created_at, lastUsedAt: i.last_used_at,
    })),
    username: account.results[0]?.username ?? null,
    // A guest has none of the above yet: the first passkey or sign-in makes them an account (src/accounts/guests.js).
    guest: !!account.results[0]?.guest,
    providers: providersReady(env),
  });
}

// The last way to sign in can't be removed: an account always keeps one. Checked inside the
// delete itself, so two removals sent at once can't both pass.
const OTHER_WAYS_LEFT =
  "((SELECT COUNT(*) FROM passkeys WHERE user_id = ?2) + (SELECT COUNT(*) FROM identities WHERE user_id = ?2)) > 1";

// What a `:name` part of the path caught arrives still percent-encoded; null when it can't be decoded.
const decoded = (part) => { try { return decodeURIComponent(part); } catch { return null; } };
const notFound = () => answer({ error: "not found", reason: "That way of signing in isn't on this account (any more)." }, 404);

/** The way was removed, or it wasn't this account's, or it was the last one: which, for the answer. */
async function removed(env, result, countSql, id, userId) {
  if (result.meta.changes) return answer({ ok: true });
  const mine = await env.DB.prepare(countSql).bind(id, userId).first();
  return mine ? answer({ error: "last way" }, 400) : notFound();
}

export async function removePasskey({ env, data, params }) {
  const id = decoded(params.id);
  if (id === null) return notFound();
  const result = await env.DB.prepare(`DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2 AND ${OTHER_WAYS_LEFT}`)
    .bind(id, data.user.id).run();
  return removed(env, result, "SELECT 1 FROM passkeys WHERE id = ?1 AND user_id = ?2", id, data.user.id);
}

export async function removeIdentity({ env, data, params }) {
  const provider = String(params.provider).toLowerCase();
  const subject = decoded(params.subject);
  if (!isProvider(provider) || subject === null) return notFound();
  const result = await env.DB.prepare(
    `DELETE FROM identities WHERE subject = ?1 AND user_id = ?2 AND provider = ?3 AND ${OTHER_WAYS_LEFT}`,
  ).bind(subject, data.user.id, provider).run();
  return removed(
    env, result, `SELECT 1 FROM identities WHERE subject = ?1 AND user_id = ?2 AND provider = '${provider}'`, subject, data.user.id,
  );
}

// ── deleting the account ───────────────────────────────────────────────────────────────────

export async function removeAccount({ request, env, data }) {
  if ((await readObject(request))?.confirm !== "delete") return answer({ error: "confirm" }, 400);
  // A trip other people are on can't lose its host: its files would have nobody to count
  // against. The answer names those trips, each with how many other people are on it, and the
  // two ways out of each: offer it to one of them (and they accept), or delete the trip. A
  // trip nobody else is on goes with the account.
  try {
    await deleteAccount(env, data.user.id);
  } catch (error) {
    if (error instanceof HostsTrips) {
      return answer({
        error: "host", trips: error.trips,
        reason: "You host a trip other people are on. Offer it to one of them and, once they accept, this account can be deleted; or delete the trip.",
      }, 409);
    }
    if (error instanceof BillingError) {
      return answer({ error: "plan not ended", reason: "Your plan couldn't be ended at Stripe just now, so the account is kept as it was. Try again in a few minutes." }, 503);
    }
    throw error;
  }
  // The rows are gone and the files are queued for the drain (src/trips/drain.js). Every AI
  // app it connected is disconnected (/mcp refuses a deleted account's token as well).
  await revokeAll(env, env.OAUTH_PROVIDER, data.user.id);
  return answer({ ok: true }, 200, signedOut());
}
