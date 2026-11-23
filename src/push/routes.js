// A person's phones, told of new messages (Web Push): the account's routes, and the chat's fan-out.
//
// GET    /api/account/push                  -> { key, push: true } (the VAPID public key a page subscribes
//                                               with), or 503 "push off" where this site sends none
// PUT    /api/account/push {endpoint, keys: {p256dh, auth}, words}
//                                            this browser's subscription, kept for this account; `words`
//                                            whether its lock screen shows what was said -> { ok, words }
// DELETE /api/account/push {endpoint}       this browser no longer told -> { ok, deleted }
//
// A new message (POST …/messages, src/api/messages.js) tells every phone of everyone else on the trip
// who hasn't muted its chat (PUT …/chat/mute): who wrote, and in which trip; the words only on a phone
// that asked for them. The send happens after the answer (env.LATER), so a slow push service never
// holds up the message; a subscription the service says has ended goes.

import { json, readJson } from "../api/json.js";
import { err } from "../api/trip.js";
import { sha256Hex } from "../accounts/util.js";
import { PUSH_PHONES_MAX } from "../../public/js/shared/limits.js";
import { allowedEndpoint, fromB64url, send, vapidOf } from "./webpush.js";

/** How many push services are asked at once for one message. */
const AT_ONCE = 6;
/** A subscription that has failed this many times in a row (not ended, just failing) goes. */
const FAILURES_MAX = 10;

export async function getPush({ env }) {
  const vapid = vapidOf(env);
  if (!vapid) return err(503, "push off", { reason: "This site doesn't send notifications (it has no push keys)." });
  return json({ push: true, key: vapid.publicKey });
}

export async function putPush({ request, env, data }) {
  if (!vapidOf(env)) return err(503, "push off", { reason: "This site doesn't send notifications (it has no push keys)." });
  const b = await readJson(request);
  const endpoint = b.endpoint;
  if (!allowedEndpoint(endpoint, env.PUSH_TEST_ORIGIN || null)) {
    return err(400, "bad endpoint", { reason: "That isn't a browser's push service address." });
  }
  const p256dh = b.keys?.p256dh;
  const auth = b.keys?.auth;
  let keysOk = false;
  try { keysOk = typeof p256dh === "string" && typeof auth === "string" && fromB64url(p256dh).length === 65 && fromB64url(auth).length === 16; } catch { keysOk = false; }
  if (!keysOk) return err(400, "bad keys", { reason: "keys are the subscription's p256dh (65 bytes) and auth (16 bytes), in base64url." });
  if (b.words !== undefined && typeof b.words !== "boolean") return err(400, "bad words", { reason: "words is true or false." });
  const id = await sha256Hex(endpoint);
  const now = Math.floor(Date.now() / 1000);
  // A browser's endpoint is its own: a phone another account had signed in on is this account's now.
  const was = await env.DB.prepare("SELECT words FROM push_subscriptions WHERE id = ?1 AND user_id = ?2").bind(id, data.user.id).first();
  const words = b.words === undefined ? !!was?.words : b.words;
  // Kept, and seen now; then an account past PUSH_PHONES_MAX phones lets go of the one least recently seen (never
  // this one): a person with a new phone is never refused.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, words, created_at, seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, endpoint = excluded.endpoint, p256dh = excluded.p256dh,
         auth = excluded.auth, words = excluded.words, failures = 0, seen_at = excluded.seen_at`,
    ).bind(id, data.user.id, endpoint, p256dh, auth, words ? 1 : 0, now),
    env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE user_id = ?1 AND id != ?2 AND id IN (
         SELECT id FROM push_subscriptions WHERE user_id = ?1 AND id != ?2 ORDER BY COALESCE(seen_at, created_at), created_at
         LIMIT MAX(0, (SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?1) - ?3))`,
    ).bind(data.user.id, id, PUSH_PHONES_MAX),
  ]);
  return json({ ok: true, words });
}

export async function deletePush({ request, env, data }) {
  const b = await readJson(request);
  if (typeof b.endpoint !== "string" || !b.endpoint) return err(400, "bad endpoint", { reason: "Say which endpoint: the subscription's own." });
  const res = await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1 AND user_id = ?2").bind(await sha256Hex(b.endpoint), data.user.id).run();
  return json({ ok: true, deleted: res.meta.changes ?? 0 });
}

/** The words a lock screen shows for a message, as Declarative Web Push's JSON (sw.js reads the same). */
export function chatPayload({ origin, trip, tripName, authorName, body, seq, words, kind = "person" }) {
  const name = authorName || "Someone";
  // The assistant's answer is by the person who asked it (migration 0033), and says so.
  const title = kind === "assistant" ? `The assistant, asked by ${name}, in ${tripName}`
    : kind === "shared" ? `${name} shared the assistant's answer in ${tripName}` : `${name} wrote in ${tripName}`;
  const text = words ? (body.length > 180 ? `${body.slice(0, 179)}…` : body) : "Open the chat to read it.";
  return JSON.stringify({
    web_push: 8030,
    notification: { title, body: text, navigate: `${origin}/t/${encodeURIComponent(trip)}/#/chat`, lang: "en", dir: "auto" },
    // sw.js's own: one notification per trip (a newer message replaces it), and the trip's mute.
    wgp: { kind: "chat", trip, seq, tag: `chat:${trip}`, mute: `/api/trips/${encodeURIComponent(trip)}/chat/mute` },
  });
}

/**
 * A new message, told: every other member's phones, unless they muted this trip's chat or have left.
 * Answers what happened, for the log and the checks: { sent, gone, failed, skipped }.
 */
export async function notifyChat(env, tripId, messageId, fetcher = fetch) {
  const vapid = vapidOf(env);
  if (!vapid) return { skipped: "push off" };
  const m = await env.DB.prepare(
    `SELECT m.author, m.body, m.seq, m.kind, t.name AS trip_name, u.name AS author_name
     FROM messages m JOIN trips t ON t.id = m.trip_id LEFT JOIN users u ON u.id = m.author
     WHERE m.trip_id = ?1 AND m.id = ?2 AND m.deleted_at IS NULL`,
  ).bind(tripId, messageId).first();
  if (!m) return { skipped: "no message" };
  const subs = (await env.DB.prepare(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth, s.words FROM push_subscriptions s
     JOIN trip_members tm ON tm.user_id = s.user_id AND tm.trip_id = ?1 AND tm.left_at IS NULL AND tm.chat_muted = 0
     WHERE s.user_id != ?2`,
  ).bind(tripId, m.author).all()).results ?? [];
  const origin = env.PUBLIC_ORIGIN || "";
  const out = { sent: 0, gone: 0, failed: 0 };
  const queue = subs.slice();
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const message = chatPayload({ origin, trip: tripId, tripName: m.trip_name, authorName: m.author_name, body: m.body, seq: m.seq, words: !!s.words, kind: m.kind });
      let r;
      try {
        r = await send(s, message, vapid, { topic: `chat${tripId}`, urgency: "normal" }, fetcher);
      } catch (e) {
        r = { ok: false, status: 0, gone: false, error: String(e?.message ?? e) };
      }
      if (r.ok) { out.sent += 1; await env.DB.prepare("UPDATE push_subscriptions SET sent_at = ?2, seen_at = ?2, failures = 0 WHERE id = ?1").bind(s.id, Math.floor(Date.now() / 1000)).run(); }
      else if (r.gone) { out.gone += 1; await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(s.id).run(); }
      else {
        out.failed += 1;
        await env.DB.prepare(`UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?1`).bind(s.id).run();
        await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id = ?1 AND failures >= ${FAILURES_MAX}`).bind(s.id).run();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));
  console.log(JSON.stringify({ chat_push: tripId, ...out }));
  return out;
}
