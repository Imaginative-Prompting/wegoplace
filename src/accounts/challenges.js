// Things that wait a few minutes for the same browser to come back: a passkey ceremony's
// challenge, a trip to Google or GitHub, a sign-in nobody has used yet (table `challenges`).
// Each is named by a short-lived cookie whose value is the row's id.

import { nowSec, randomId } from "./util.js";

/** Keeps something for `seconds` and returns its id. Rows past their time are cleared as new ones arrive. */
export async function keep(env, { id = randomId(18), kind, value, userId = null, userName = null, seconds }) {
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM challenges WHERE expires_at < ?1").bind(now),
    env.DB.prepare(
      "INSERT OR REPLACE INTO challenges (id, kind, challenge, user_id, user_name, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(id, kind, value, userId, userName, now + seconds),
  ]);
  return id;
}

/**
 * Takes it, once: read and deleted in one statement, so two requests at once with the same
 * cookie can't both have it. Only the kind looked for (the cookie's value is the browser's to
 * choose). One past its time is taken and answers null.
 */
export async function take(env, id, kind, now = nowSec()) {
  if (!id) return null;
  const row = await env.DB.prepare(
    "DELETE FROM challenges WHERE id = ?1 AND kind = ?2 RETURNING challenge, user_id, user_name, expires_at",
  ).bind(id, kind).first();
  return row && row.expires_at > now ? row : null;
}

/** Reads it and leaves it there. */
export async function peek(env, id, kind, now = nowSec()) {
  if (!id) return null;
  return env.DB.prepare("SELECT challenge, user_id, user_name FROM challenges WHERE id = ?1 AND kind = ?2 AND expires_at > ?3")
    .bind(id, kind, now).first();
}

export async function drop(env, id, kind) {
  if (id) await env.DB.prepare("DELETE FROM challenges WHERE id = ?1 AND kind = ?2").bind(id, kind).run();
}
