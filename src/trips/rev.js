// A trip's rev: one number that goes up by one in every write to anything in the trip.
//
// A client keeps the rev of the snapshot it holds and asks GET /api/trips/<id>/rev (cheap:
// one row) to learn whether anything changed; each row also keeps the trip's rev as of its own
// last write.
//
// How a write does it: bump() goes FIRST in the same batch as the write (a batch is one
// transaction), and the rows written in that batch set `rev = REV(n)`, where ?n is the trip's
// id. A write that turns out to change nothing still moves the rev; that costs a client one
// snapshot it didn't need and can never hide a change.

import { closeSteps, openSteps } from "./changes.js";
import { tellRoom } from "./live.js";

/** The statement that moves a trip's rev on by one, and its data_rev with it. First in the write's batch. */
export const bump = (env, tripId) =>
  env.DB.prepare("UPDATE trips SET rev = rev + 1, data_rev = rev + 1 WHERE id = ?1 RETURNING rev").bind(tripId);

/**
 * The chat's own: the rev moves (so a client reading only rev still sees it) and so does the chat's
 * counter, but not data_rev, so a phone reads the new messages and not the whole trip (migration
 * 0024; docs/API.md). First in a chat write's batch.
 */
export const bumpChat = (env, tripId, { data = false } = {}) =>
  env.DB.prepare(`UPDATE trips SET rev = rev + 1, message_seq = message_seq + 1${data ? ", data_rev = rev + 1" : ""} WHERE id = ?1 RETURNING rev, message_seq`).bind(tripId);

/** SQL for "the chat's counter now", where parameter ?n is the trip's id. For a message written after bumpChat(). */
export const SEQ = (n) => `(SELECT message_seq FROM trips WHERE id = ?${n})`;

/** SQL for "the trip's rev now", where parameter ?n is the trip's id. For rows written after bump(). */
export const REV = (n) => `(SELECT rev FROM trips WHERE id = ?${n})`;

/**
 * Runs `statements` as one write to the trip: the rev moves, then they run, all or nothing.
 * Answers { rev, results } with `results` in the order of `statements`. The trip's room hears the
 * new rev once it has landed (moved(), below); `room` is what else it hears.
 *
 * A request that carries a change (`env.CHANGE`: an MCP tool's call, or an undo; see
 * src/trips/changes.js) opens it right after the rev moves and closes it last, in the same
 * batch, so the database's triggers record exactly the rows these statements touch.
 */
export async function write(env, tripId, statements, room = {}) {
  const open = env.CHANGE ? openSteps(env, tripId) : [];
  const close = env.CHANGE ? closeSteps(env, tripId) : [];
  const all = await env.DB.batch([bump(env, tripId), ...open, ...statements, ...close]);
  const rev = all[0].results[0]?.rev ?? null;
  await moved(env, tripId, rev, room);
  return { rev, results: all.slice(1 + open.length, 1 + open.length + statements.length) };
}

/**
 * A write to the trip's chat: as write(), with bumpChat() first. Answers { rev, seq, results }. No
 * change records it (no tool writes the chat). `data`: it changes what the trip's snapshot holds
 * too (the counts of messages about each thing, and the words the Agenda writes on the time
 * before a plan), so data_rev moves as well and a phone reads the trip again.
 */
export async function writeChat(env, tripId, statements, { data = false } = {}) {
  const all = await env.DB.batch([bumpChat(env, tripId, { data }), ...statements]);
  const { rev = null, message_seq: seq = null } = all[0].results[0] ?? {};
  await moved(env, tripId, rev);
  return { rev, seq, results: all.slice(1) };
}

/**
 * Every write that moves a trip's rev tells the trip's room, after it lands: write() does, and so
 * does each of the few writes that move a rev in a batch of their own (check:live reads the code
 * for one that doesn't). `room` adds who leaves with it ({ drop: <account id> }) or that the trip
 * is gone ({ gone: true }). Never fails the write (src/trips/live.js tellRoom).
 */
export function moved(env, tripId, rev, room = {}) {
  return tellRoom(env, tripId, { rev, ...room });
}
