// Deleting an account.
//
// What goes: every way it signs in (passkeys, Google and GitHub sign-ins, sessions, its email),
// its settings, its own packing lists, its memories with their photos and videos, the files it
// uploaded that are in nobody's memory, the boards it shared by link, with their files, and the
// bug reports it sent, with their screenshots.
//
// What stays, under the name it had: the money it paid and owed (other people's balances are
// made of it), and what it added to the shared plan: events, places, notes, and items on the
// group's packing list. A photo it uploaded into someone else's memory stays with that memory.
// For those the account's row is kept with its name and nothing else, marked deleted; nobody
// can sign in to it again. On each trip it was on it is someone who left.
//
// Trips it hosts: one that nobody else is on goes with the account, whole (src/trips/delete.js).
// One that other people are on stops the deletion: its files count against its host, and a
// trip can't be left without one. The host hands it to another member first.

import { tripDeleteSteps } from "../trips/delete.js";
import { queueFiles } from "../trips/drain.js";
import { forgetUser } from "./sessions.js";
import { moved } from "../trips/rev.js";
import { BILLING_TABLES, endForDeletion } from "../billing/plan.js";
import { DELETE_STATEMENTS as ASSISTANT_DELETES } from "../assistant/meter.js";
import { TALK_DELETES } from "../assistant/talk.js";
import { BUG_REPORT_DELETES } from "../bug-reports.js";
import { nowSec } from "./util.js";
import { sweepDrawings } from "./avatar.js";

const MEMORIES = "SELECT id FROM memories WHERE created_by = ?1";
const SHARES = "SELECT id FROM collage_shares WHERE created_by = ?1";
// Anyone's live boards that show a photograph from one of its memories (an item records its
// memory). A memory that goes leaves every board it is on (model §8), whoever made the board.
const BOARDS_SHOWING = `SELECT DISTINCT i.share_id FROM collage_share_items i JOIN collage_shares s ON s.id = i.share_id
  WHERE s.revoked_at IS NULL AND i.memory_id IN (${MEMORIES})`;
// The same boards once revoked: every board an item of its memories is on.
const BOARDS_WITH = `SELECT DISTINCT share_id FROM collage_share_items WHERE memory_id IN (${MEMORIES})`;

/** The account can't be deleted: it hosts trips other people are on (`trips`, each with how many). */
export class HostsTrips extends Error {
  constructor(trips) {
    super("hosts trips");
    this.trips = trips;
  }
}

/** The trips the account hosts, each with the number of OTHER people on it now. */
async function hosted(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT t.id, t.name,
       (SELECT COUNT(*) FROM trip_members m WHERE m.trip_id = t.id AND m.user_id != ?1 AND m.left_at IS NULL) AS others
     FROM trips t WHERE t.host_id = ?1 ORDER BY t.created_at, t.id`,
  ).bind(userId).all();
  return rows.results || [];
}

/**
 * Removes the account's rows in one transaction, and queues the files those rows named for the
 * drain (src/trips/drain.js) in the same transaction. A file whose row is gone is served to
 * nobody, so nothing is left readable, and nothing is lost if the Worker stops halfway.
 *
 * Throws HostsTrips, having changed nothing, when the account hosts a trip someone else is on.
 */
export async function deleteAccount(env, userId, now = nowSec()) {
  const db = env.DB;
  const one = (sql) => db.prepare(sql).bind(userId);
  const trips = await hosted(env, userId);
  const shared = trips.filter((t) => t.others > 0);
  if (shared.length) throw new HostsTrips(shared.map((t) => ({ id: t.id, name: t.name, members: t.others })));
  // A plan this account pays for ends at Stripe first, so nothing is charged after (src/billing/plan.js):
  // if Stripe can't be reached the deletion waits, with nothing changed here.
  await endForDeletion(env, userId, now);

  // The first statement can only fail, and fails the whole transaction with it: it tries to
  // write a row that can't exist if, by now, the account hosts a trip someone else is on
  // (they joined a moment ago), or hosts a trip that wasn't in the list read above. Without it
  // a trip could be deleted under someone who had just joined it, or left with a host who is gone.
  const guard = db.prepare(
    `INSERT INTO trip_members (trip_id, user_id, joined_at)
     SELECT NULL, NULL, 0
     WHERE EXISTS (SELECT 1 FROM trips t JOIN trip_members m ON m.trip_id = t.id
                   WHERE t.host_id = ?1 AND m.user_id != ?1 AND m.left_at IS NULL)
        OR (SELECT COUNT(*) FROM trips WHERE host_id = ?1) != ?2`,
  ).bind(userId, trips.length);

  // The trips it hosts alone, whole.
  const tripSteps = trips.flatMap((t) => tripDeleteSteps(env, t.id, now));

  const steps = [
    { stmt: guard },
    ...tripSteps,
    // Boards showing one of its memories, other people's too, are unshared, as when a memory is
    // deleted on its own (src/api/collage.js revokeStatements): their files to the drain, the
    // link dead. Before the memories go, since the boards are found through them; marked revoked
    // before their items go, since the items are how they are found. Each takes the rev its trip
    // is about to have (every trip it is on moves by one, below).
    { stmt: queueFiles(env, `SELECT r2_key, NULL AS upload_id FROM collage_share_items WHERE share_id IN (${BOARDS_SHOWING})
        UNION SELECT image_key, NULL FROM collage_shares WHERE id IN (${BOARDS_SHOWING})
        UNION SELECT video_key, NULL FROM collage_shares WHERE id IN (${BOARDS_SHOWING})`, [userId], now) },
    { stmt: db.prepare(`UPDATE collage_shares SET revoked_at = ?2, revoked_why = 'memory', rev = (SELECT t.rev + 1 FROM trips t WHERE t.id = collage_shares.trip_id)
        WHERE id IN (${BOARDS_SHOWING})`).bind(userId, now) },
    { stmt: one(`DELETE FROM collage_share_items WHERE share_id IN (${BOARDS_WITH})`) },
    // Its memories on other people's trips: the files in them (whoever uploaded each), their
    // tags, the memories. The files to the drain first.
    { stmt: queueFiles(env, `SELECT r2_key, NULL AS upload_id FROM memory_media WHERE memory_id IN (${MEMORIES})
        UNION SELECT thumb_key, NULL FROM memory_media WHERE memory_id IN (${MEMORIES})`, [userId], now) },
    {
      stmt: one(`DELETE FROM media_objects WHERE r2_key IN (
           SELECT r2_key FROM memory_media WHERE memory_id IN (${MEMORIES})
           UNION SELECT thumb_key FROM memory_media WHERE memory_id IN (${MEMORIES}))`),
    },
    { stmt: one(`DELETE FROM memory_tags WHERE memory_id IN (${MEMORIES})`) },
    { stmt: one(`DELETE FROM memory_media WHERE memory_id IN (${MEMORIES})`) },
    { stmt: one("DELETE FROM memories WHERE created_by = ?1") },
    // What it uploaded that is in nobody's memory now, an upload still under way included.
    // A picture on a place, an event, the cover or a receipt is the trip's, whoever added it:
    // it stays (pictures), and so does one a change holds for its undo (files_held).
    { stmt: queueFiles(env, `SELECT r2_key, CASE WHEN state = 'pending' THEN NULLIF(upload_id, '') END AS upload_id FROM media_objects
        WHERE user_id = ?1 AND r2_key NOT IN (SELECT r2_key FROM memory_media UNION SELECT thumb_key FROM memory_media UNION SELECT r2_key FROM pictures UNION SELECT r2_key FROM files_held)`, [userId], now) },
    {
      stmt: one(`DELETE FROM media_objects WHERE user_id = ?1 AND r2_key NOT IN (
           SELECT r2_key FROM memory_media UNION SELECT thumb_key FROM memory_media UNION SELECT r2_key FROM pictures UNION SELECT r2_key FROM files_held)`),
    },
    // Upload links it made can't be used any more (whoever made a link must be on the trip).
    { stmt: one("DELETE FROM picture_links WHERE created_by = ?1") },
    // The boards it shared by link, with their files.
    { stmt: queueFiles(env, `SELECT r2_key, NULL AS upload_id FROM collage_share_items WHERE share_id IN (${SHARES})
        UNION SELECT image_key, NULL FROM collage_shares WHERE created_by = ?1 UNION SELECT video_key, NULL FROM collage_shares WHERE created_by = ?1`, [userId], now) },
    { stmt: one(`DELETE FROM collage_share_items WHERE share_id IN (${SHARES})`) },
    { stmt: one("DELETE FROM collage_shares WHERE created_by = ?1") },
    // A trip offered to it, or by it, isn't any more.
    { stmt: one("DELETE FROM trip_handovers WHERE to_user = ?1 OR offered_by = ?1") },
    // Its own packing items, with their bags and ticks. The group's are everyone's and stay
    // (a tick it made on one of them stays too: the group's tick, whoever made it).
    { stmt: one("DELETE FROM packing_ticks WHERE item_id IN (SELECT id FROM packing_items WHERE owner = ?1)") },
    { stmt: one("DELETE FROM packing_placements WHERE item_id IN (SELECT id FROM packing_items WHERE owner = ?1)") },
    { stmt: one("DELETE FROM packing_items WHERE owner = ?1") },
    // On every trip it was on, something changed (what it stored is gone, and it has left):
    // each trip's rev goes up, and its own row there takes it.
    { tells: true, stmt: one(
      `UPDATE trips SET rev = rev + 1, data_rev = rev + 1
       WHERE id IN (SELECT trip_id FROM trip_members WHERE user_id = ?1 AND left_at IS NULL) RETURNING id, rev`) },
    { stmt: db.prepare(
      `UPDATE trip_members SET left_at = ?2, rev = (SELECT rev FROM trips WHERE id = trip_members.trip_id)
       WHERE user_id = ?1 AND left_at IS NULL`,
    ).bind(userId, now) },
    // Its Stripe customer's disputes, as we last had them: kept only to hold the plan's assistant while one is open,
    // so they go with the account (Stripe keeps the dispute itself). Before billing_customers, which says whose they are.
    { stmt: one("DELETE FROM billing_disputes WHERE customer IN (SELECT customer FROM billing_customers WHERE user_id = ?1)") },
    // Every way in.
    ...["sessions", "old_cookie_accounts", "passkeys", "identities", "signin_links", "account_emails", "email_codes", "challenges", "push_subscriptions", "account_exports", ...BILLING_TABLES]
      .map((table) => ({ stmt: one(`DELETE FROM ${table} WHERE user_id = ?1`) })),
    // The links it made, as a trip's host, to sign a guest in again (0040), and their count.
    { stmt: one("DELETE FROM signin_links WHERE made_by = ?1") },
    { stmt: one("DELETE FROM hour_counts WHERE kind = 'rejoin-host' AND key = ?1") },
    // The codes it asked for keep counting against their addresses for their hour, no longer its.
    { stmt: one("UPDATE email_sends SET user_id = NULL WHERE user_id = ?1") },
    // The assistant (0031): its tag, its own ledger as a host; its asks on others' trips without who asked.
    ...ASSISTANT_DELETES(db, userId).map((stmt) => ({ stmt })),
    // Its conversations with the assistant (0032), every one of them: they were its alone.
    ...TALK_DELETES(db, userId).map((stmt) => ({ stmt })),
    // Its bug reports (0047): their screenshots to the drain, then the reports.
    ...BUG_REPORT_DELETES(env, userId, now).map((stmt) => ({ stmt })),
    // The row that stays: the name, and that it is gone.
    { stmt: db.prepare(
      `UPDATE users SET username = NULL, note_color = NULL, initials = NULL, native_currency = NULL,
         tab_layout = NULL, guest = 0, avatar = NULL, deleted_at = ?2 WHERE id = ?1`,
    ).bind(userId, now) },
    // Its drawn picture (0043), unless someone else holds the same one, and its picture writes' count.
    { stmt: sweepDrawings(db) },
    { stmt: one("DELETE FROM hour_counts WHERE kind = 'avatar' AND key = ?1") },
  ];

  let done;
  try {
    done = await db.batch(steps.map((s) => s.stmt));
  } catch (error) {
    // The guard: say why, if that is why.
    const nowShared = (await hosted(env, userId)).filter((t) => t.others > 0);
    if (nowShared.length) throw new HostsTrips(nowShared.map((t) => ({ id: t.id, name: t.name, members: t.others })));
    throw error;
  }
  forgetUser(userId);
  // The rooms: each trip it was on hears its new rev with this account's sockets closed; a trip it
  // hosted alone is gone, and its room closes.
  const left = done[steps.findIndex((s) => s.tells)].results ?? [];
  await Promise.all([
    ...left.map((t) => moved(env, t.id, t.rev, { drop: userId })),
    ...trips.map((t) => moved(env, t.id, null, { gone: true })),
  ]);
  // How many files went to the drain (the statements that queue them, in order).
  const files = steps.reduce((n, step, i) => n + (step.stmt.queues ? done[i].meta.changes : 0), 0);
  return { trips: trips.length, files };
}
