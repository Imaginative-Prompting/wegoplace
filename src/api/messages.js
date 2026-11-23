// The trip's chat (model §17; migration 0024). Under /api/trips/<trip>/ (the route table checks
// the caller is on the trip):
//
// GET    messages[?before=<seq>|?after=<n>][&about=<kind>:<id>][&limit=<n>]
//                       -> { messages, seq, more }
//          no cursor: the newest window (oldest first); before=<seq>: the window before that
//          message, paging back; after=<n>: every message the chat changed after its counter was
//          n (new ones, and older ones edited or deleted since), what a phone asks when /rev's
//          `seq` moved. about=event:<id> (or place:, purchase:): only the ones about that thing.
//          `seq` is the chat's counter now; `more` that there are older ones (before) or more
//          changed ones than one answer holds (after: ask again from the last `touched`).
// POST   messages {id, body, about?: {kind, id, part?}}  -> { message, rev, seq }   (201; 200 on a replay)
// PATCH  messages/:id {body}                             -> { message, rev, seq }   the author only
// DELETE messages/:id                                    -> { message, rev, seq }   the author, or the host
// PUT    chat/mute {muted}                               -> { muted, rev }          the caller's own
//
// The id is the sender's, so a message waiting in a phone's queue and sent twice lands once.
// Every message carries `seq`, the server's order (never the phone's clock), and `touched`, the
// counter at its last change. A message about a thing keeps the thing's name as it was when it
// was written (`about.name`), so one about something later deleted still says what it was about.
// A deleted message keeps its place, its author and when, with its words gone.
//
// Each write goes through writeChat() (src/trips/rev.js): the trip's rev and the chat's counter
// move, data_rev doesn't, and the trip's room hears the new rev.

import { json, readJson } from "./json.js";
import { err, nowSec } from "./trip.js";
import { readNewId } from "../../public/js/shared/trip-rules.js";
import { MESSAGE_MAX, MESSAGES_PAGE_MAX, MESSAGES_PER_MINUTE, MESSAGES_PER_TRIP_MAX } from "../../public/js/shared/limits.js";
import { SEQ, write, writeChat } from "../trips/rev.js";
import { notifyChat } from "../push/routes.js";
import { askInChat, namesAssistant } from "../assistant/talk.js";
import { errorLine } from "../log.js";

const COLS = "m.id, m.seq, m.touched, m.author, u.name AS author_name, m.body, m.about_kind, m.about_id, m.about_part, m.about_name, " +
  "m.created_at, m.edited_at, m.deleted_at, m.deleted_by, m.rev, m.from_note, m.kind, m.reply_to, m.working, m.detail";
const FROM = "FROM messages m JOIN users u ON u.id = m.author";
const KINDS = ["event", "place", "purchase"];

/** A message as the app and the routes answer it. */
export const shape = (m) => ({
  id: m.id, seq: m.seq, touched: m.touched, author: m.author, author_name: m.author_name ?? "",
  body: m.deleted_at ? "" : m.body,
  about: m.about_kind ? { kind: m.about_kind, id: m.about_id, ...(m.about_part ? { part: m.about_part } : {}), name: m.about_name } : null,
  created_at: m.created_at, edited_at: m.edited_at ?? null,
  deleted: m.deleted_at ? { at: m.deleted_at, by: m.deleted_by } : null,
  rev: m.rev,
  // Made from a note on a plan when notes moved into the chat (migration 0027): words the people
  // on the trip had already read, so never new to anyone.
  ...(m.from_note ? { from_note: true } : {}),
  // The assistant's (migration 0033): its answer to a message naming @assistant, authored by the person
  // who asked, with the step it's on while it works; or a question and its answer shared from someone's
  // own conversation. A person's message answers exactly as before.
  ...(m.kind && m.kind !== "person" ? kindOf(m) : {}),
});

function kindOf(m) {
  let d = {};
  try { d = JSON.parse(m.detail || "{}") ?? {}; } catch { d = {}; }
  if (m.kind === "assistant") {
    return { kind: "assistant", reply_to: m.reply_to ?? null, working: m.deleted_at ? null : (m.working ?? null),
      ...(m.working || m.deleted_at ? {} : { did: Array.isArray(d.did) ? d.did : [], stopped: d.stopped ?? null }) };
  }
  return { kind: "shared", shared: m.deleted_at ? null : { question: String(d.question ?? ""), answer: String(d.answer ?? "") } };
}

const one = async (env, tripId, id) => {
  const row = await env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE m.trip_id = ?1 AND m.id = ?2`).bind(tripId, id).first();
  return row ? shape(row) : null;
};
const noSuchMessage = (id) => err(404, "no such message", { id, reason: `There's no message "${String(id).slice(0, 64)}" in this trip's chat.` });

/**
 * How many messages are about each thing, for the snapshot: { event: { <id>: n }, place: …,
 * purchase: …, before: { <event id>: n }, before_recent: { <event id>: [two newest] } }. `event`
 * counts every message about the plan, the time before it included; `before` those about the time
 * before it alone (the Agenda shows them on the free time in front of the plan, and the rest on
 * the plan's card), and `before_recent` the newest two of those, oldest first.
 */
export async function messageCounts(env, tripId) {
  const [counts, recent] = await env.DB.batch([
    env.DB.prepare(
      `SELECT about_kind, about_id, COUNT(*) AS n, SUM(about_part = 'before') AS before FROM messages
       WHERE trip_id = ?1 AND deleted_at IS NULL AND about_kind IS NOT NULL GROUP BY about_kind, about_id`,
    ).bind(tripId),
    // The newest two about the time before each plan, words and all: the Agenda writes them on the
    // free time in front of the plan, with no signal too. A gap has room for the whole note and the
    // newest message, so both are drawn there, not a count alone.
    env.DB.prepare(
      `SELECT about_id, id, author, author_name, body, created_at FROM (
         SELECT m.about_id, m.id, m.author, u.name AS author_name, m.body, m.created_at, m.seq,
           ROW_NUMBER() OVER (PARTITION BY m.about_id ORDER BY m.seq DESC) AS r
         FROM messages m JOIN users u ON u.id = m.author
         WHERE m.trip_id = ?1 AND m.about_kind = 'event' AND m.about_part = 'before' AND m.deleted_at IS NULL)
       WHERE r <= 2 ORDER BY about_id, seq`,
    ).bind(tripId),
  ]);
  const about = { event: {}, place: {}, purchase: {}, before: {}, before_recent: {} };
  for (const r of counts.results ?? []) {
    about[r.about_kind][r.about_id] = r.n;
    if (r.before) about.before[r.about_id] = r.before;
  }
  for (const r of recent.results ?? []) {
    (about.before_recent[r.about_id] ??= []).push({ id: r.id, author: r.author, author_name: r.author_name ?? "", body: r.body, created_at: r.created_at });
  }
  return about;
}

/** A whole number from a query string, or null when it's absent; NaN when it's there and isn't one. */
const wholeOf = (v) => (v === null ? null : /^\d{1,15}$/.test(v) ? Number(v) : NaN);

export async function listMessages({ request, env, data }) {
  const { trip } = data;
  const q = new URL(request.url).searchParams;
  const before = wholeOf(q.get("before"));
  const after = wholeOf(q.get("after"));
  const limit = wholeOf(q.get("limit")) ?? 50;
  if (Number.isNaN(before) || Number.isNaN(after)) return err(400, "bad cursor", { reason: "before and after are a message's seq, or the chat's counter: whole numbers." });
  if (before !== null && after !== null) return err(400, "bad cursor", { reason: "Ask for messages before a seq, or changed after a counter: one or the other." });
  if (Number.isNaN(limit) || limit < 1 || limit > MESSAGES_PAGE_MAX) return err(400, "bad limit", { reason: `A read answers 1 to ${MESSAGES_PAGE_MAX} messages.` });
  const where = ["m.trip_id = ?1"];
  const args = [trip.id];
  const about = q.get("about");
  if (about !== null) {
    const m = /^(event|place|purchase):(.{1,64})$/.exec(about);
    if (!m) return err(400, "bad about", { reason: "about is a thing's kind and id: event:<id>, place:<id> or purchase:<id>." });
    args.push(m[1], m[2]);
    where.push(`m.about_kind = ?${args.length - 1} AND m.about_id = ?${args.length}`);
  }
  let rows;
  if (after !== null) {
    args.push(after);
    where.push(`m.touched > ?${args.length}`);
    rows = (await env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY m.touched LIMIT ${limit + 1}`).bind(...args).all()).results ?? [];
  } else {
    if (before !== null) { args.push(before); where.push(`m.seq < ?${args.length}`); }
    rows = (await env.DB.prepare(`SELECT ${COLS} ${FROM} WHERE ${where.join(" AND ")} ORDER BY m.seq DESC LIMIT ${limit + 1}`).bind(...args).all()).results ?? [];
  }
  const more = rows.length > limit;
  const page = rows.slice(0, limit).map(shape);
  if (after === null) page.reverse();
  else page.sort((a, b) => a.seq - b.seq);
  return json({ messages: page, seq: trip.message_seq, more });
}

/** The thing a message is about: { about } with its name now, or { bad }. */
async function readAbout(env, tripId, raw) {
  if (raw === undefined || raw === null) return { about: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { bad: err(400, "bad about", { reason: "about is { kind, id }: the event, place or purchase the message is about." }) };
  if (!KINDS.includes(raw.kind)) return { bad: err(400, "bad about", { kinds: KINDS, reason: `A message is about an event, a place or a purchase, not "${String(raw.kind ?? "").slice(0, 20)}".` }) };
  if (raw.part !== undefined && raw.part !== null && !(raw.kind === "event" && raw.part === "before")) {
    return { bad: err(400, "bad about", { reason: "The only part a message can be about is the time before an event: part \"before\", with kind \"event\"." }) };
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  const SQL = {
    event: "SELECT title AS name FROM events WHERE trip_id = ?1 AND id = ?2",
    place: "SELECT name FROM places WHERE trip_id = ?1 AND id = ?2",
    purchase: "SELECT description AS name FROM purchases WHERE trip_id = ?1 AND id = ?2 AND kind = 'purchase'",
  };
  const row = id ? await env.DB.prepare(SQL[raw.kind]).bind(tripId, id).first() : null;
  if (!row) return { bad: err(404, "no such thing", { about: { kind: raw.kind, id }, reason: `There's no ${raw.kind} "${id.slice(0, 64)}" on this trip to write about.` }) };
  return { about: { kind: raw.kind, id, part: raw.part === "before" ? "before" : null, name: String(row.name ?? "").slice(0, 200) } };
}

const readBody = (raw) => {
  if (typeof raw !== "string" || !raw.trim()) return { bad: err(400, "no words", { reason: "A message needs some words." }) };
  if (raw.length > MESSAGE_MAX) return { bad: err(400, "too long", { max: MESSAGE_MAX, reason: `A message is at most ${MESSAGE_MAX.toLocaleString("en")} characters; this one is ${raw.length.toLocaleString("en")}. Send it as two.` }) };
  return { body: raw };
};

export async function postMessage({ request, env, data }) {
  return sendMessage(env, data, await readJson(request));
}

/** Writes the message `b` ({ id, body, about? }) as the caller (POST messages). Answers the Response. */
export async function sendMessage(env, data, b) {
  const { user, trip } = data;
  const okId = readNewId(b.id);
  if (!okId.ok) return err(400, "bad id", { id: b.id ?? null, reason: okId.error });
  const id = okId.id;
  // Sent again (a queue's replay): the same message, written once.
  const there = await one(env, trip.id, id);
  if (there) {
    if (there.author !== user.id) return err(409, "id already exists", { id, reason: `"${id}" is already another message's id: choose another.` });
    return json({ message: there, rev: trip.rev, seq: trip.message_seq });
  }
  const body = readBody(b.body);
  if (body.bad) return body.bad;
  const about = await readAbout(env, trip.id, b.about);
  if (about.bad) return about.bad;
  const now = nowSec();
  // This person's last minute, on its index (trip, author, time): at most MESSAGES_PER_MINUTE rows read,
  // never the whole chat (tools/trip-cost.mjs measured 5,018 rows a message on a 5,000-message chat).
  const minute = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE trip_id = ?1 AND author = ?2 AND created_at > ?3",
  ).bind(trip.id, user.id, now - 60).first();
  if (minute.n >= MESSAGES_PER_MINUTE) {
    return err(429, "too many messages", { max: MESSAGES_PER_MINUTE, reason: `That's ${MESSAGES_PER_MINUTE} messages in a minute: wait a moment, then send it.` }, { "Retry-After": "60" });
  }
  // The chat's cap. Every message takes a seq from trips.message_seq (and edits move it too), so a chat
  // whose counter is under the cap can't be full: only past it are its messages counted.
  if ((trip.message_seq ?? 0) >= MESSAGES_PER_TRIP_MAX
    && (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE trip_id = ?1").bind(trip.id).first()).n >= MESSAGES_PER_TRIP_MAX) {
    return err(409, "the chat is full", { max: MESSAGES_PER_TRIP_MAX, reason: `This trip's chat holds ${MESSAGES_PER_TRIP_MAX.toLocaleString("en")} messages, and has them all. Nothing is deleted to make room: the trip's host can start a new trip for what comes next, and this one keeps its chat as it is.` });
  }
  const a = about.about;
  // A message about a thing moves the snapshot's counts (and, about the time before a plan, the
  // words the Agenda writes on it): data_rev moves too, so the other phones read the trip.
  const { rev, seq, results } = await writeChat(env, trip.id, [env.DB.prepare(
    `INSERT INTO messages (trip_id, id, seq, touched, author, body, about_kind, about_id, about_part, about_name, created_at, rev)
     VALUES (?1, ?2, ${SEQ(1)}, ${SEQ(1)}, ?3, ?4, ?5, ?6, ?7, ?8, ?9, (SELECT rev FROM trips WHERE id = ?1))
     ON CONFLICT(trip_id, id) DO NOTHING`,
  ).bind(trip.id, id, user.id, body.body, a?.kind ?? null, a?.id ?? null, a?.part ?? null, a?.name ?? "", now)], { data: !!a });
  const message = await one(env, trip.id, id);
  // Everyone else on the trip told, after the answer (src/push/routes.js): only for a message this
  // request wrote, never for one sent again.
  if (results[0].meta.changes && env.LATER) {
    env.LATER(notifyChat(env, trip.id, id).catch((e) => console.log(JSON.stringify({ chat_push_failed: trip.id, error: errorLine(e, env) }))));
  }
  // @assistant anywhere in it: the assistant answers in the chat, as its own kind of message by this person
  // (src/assistant/talk.js askInChat). Whether it will, and why not, is said to the sender alone.
  const assistant = results[0].meta.changes && namesAssistant(body.body)
    ? await askInChat(env, { user, trip, message, origin: env.PUBLIC_ORIGIN }) : null;
  // Sent twice at once: the other one wrote it, and this answers the same.
  return json({ message, rev, seq, ...(assistant ? { assistant } : {}) }, results[0].meta.changes ? 201 : 200);
}

/** The message and whether the caller may touch it, or a refusal. */
async function mine(env, data, id, { hostToo }) {
  const m = await one(env, data.trip.id, id);
  if (!m) return { bad: noSuchMessage(id) };
  if (m.author !== data.user.id && !(hostToo && data.host)) {
    return { bad: err(403, "forbidden", { reason: hostToo ? "Only the person who wrote this message, or the trip's host, can delete it." : "Only the person who wrote this message can change it." }) };
  }
  return { m };
}

export async function patchMessage({ request, env, data, params }) {
  const { trip } = data;
  const id = String(params.id ?? "");
  const got = await mine(env, data, id, { hostToo: false });
  if (got.bad) return got.bad;
  if (got.m.deleted) return err(409, "deleted", { reason: "This message was deleted; it can't be changed now." });
  if (got.m.kind === "assistant" || got.m.kind === "shared") {
    return err(409, "not editable", { reason: "The assistant's words can't be changed, here or shared: delete the message if it shouldn't stay." });
  }
  const b = await readJson(request);
  const body = readBody(b.body);
  if (body.bad) return body.bad;
  if (body.body === got.m.body) return json({ message: got.m, rev: trip.rev, seq: trip.message_seq });
  const { rev, seq } = await writeChat(env, trip.id, [env.DB.prepare(
    `UPDATE messages SET body = ?3, edited_at = ?4, touched = ${SEQ(1)}, rev = (SELECT rev FROM trips WHERE id = ?1)
     WHERE trip_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  ).bind(trip.id, id, body.body, nowSec())], { data: got.m.about?.part === "before" });
  return json({ message: await one(env, trip.id, id), rev, seq });
}

export async function deleteMessage({ env, data, params }) {
  const { trip, user } = data;
  const id = String(params.id ?? "");
  const got = await mine(env, data, id, { hostToo: true });
  if (got.bad) return got.bad;
  // Deleted already (sent twice): the same answer, nothing written.
  if (got.m.deleted) return json({ message: got.m, rev: trip.rev, seq: trip.message_seq });
  const { rev, seq } = await writeChat(env, trip.id, [env.DB.prepare(
    `UPDATE messages SET body = '', deleted_at = ?3, deleted_by = ?4, touched = ${SEQ(1)}, rev = (SELECT rev FROM trips WHERE id = ?1)
     WHERE trip_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  ).bind(trip.id, id, nowSec(), user.id)], { data: !!got.m.about });
  return json({ message: await one(env, trip.id, id), rev, seq });
}

/** PUT chat/mute {muted}: the caller's own choice for this trip's chat: muted, none of its messages reaches their phones. */
export async function putMute({ request, env, data }) {
  const { trip, user } = data;
  const b = await readJson(request);
  if (typeof b.muted !== "boolean") return err(400, "bad muted", { reason: "muted is true or false." });
  const { rev } = await write(env, trip.id, [env.DB.prepare(
    "UPDATE trip_members SET chat_muted = ?3, rev = (SELECT rev FROM trips WHERE id = ?1) WHERE trip_id = ?1 AND user_id = ?2 AND left_at IS NULL",
  ).bind(trip.id, user.id, b.muted ? 1 : 0)]);
  return json({ muted: b.muted, rev });
}
