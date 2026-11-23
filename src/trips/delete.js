// Everything a trip stores, as the statements that remove it.
//
// Used by DELETE /api/trips/<id> (src/trips/trips.js) and by deleting an account that hosts a
// trip nobody else is on (src/accounts/delete.js).
//
// The statements are for ONE batch (one transaction), in an order the foreign keys allow:
// what points at a row goes before the row. The files the rows name are queued for the drain
// (src/trips/drain.js) in the same batch, before their rows go: a file whose row is gone is
// served to nobody, and what the trip held stops counting in that request.

import { queueFiles } from "./drain.js";
import { FILES_DELETES } from "../assistant/files.js";

const MEMORIES = "SELECT id FROM memories WHERE trip_id = ?1";
const ITEMS = "SELECT id FROM packing_items WHERE trip_id = ?1";
const SHARES = "SELECT id FROM collage_shares WHERE trip_id = ?1";
const PURCHASES = "SELECT id FROM purchases WHERE trip_id = ?1";

export function tripDeleteSteps(env, tripId, now) {
  const one = (sql) => env.DB.prepare(sql).bind(tripId);
  return [
    // Every file the trip holds, to the drain: what was uploaded to it (an upload still under
    // way is aborted), and the boards shared from it.
    { stmt: queueFiles(env, "SELECT r2_key, CASE WHEN state = 'pending' THEN NULLIF(upload_id, '') END AS upload_id FROM media_objects WHERE trip_id = ?1", [tripId], now) },
    { stmt: queueFiles(env, `SELECT r2_key, NULL AS upload_id FROM collage_share_items WHERE share_id IN (${SHARES})
        UNION SELECT image_key, NULL FROM collage_shares WHERE trip_id = ?1 UNION SELECT video_key, NULL FROM collage_shares WHERE trip_id = ?1`, [tripId], now) },
    { stmt: one("DELETE FROM trip_handovers WHERE trip_id = ?1") },
    // Its pictures and the links to upload them (their files are queued above, with every file
    // the trip holds); before the files' rows, which they point at.
    { stmt: one("DELETE FROM pictures WHERE trip_id = ?1") },
    { stmt: one("DELETE FROM picture_links WHERE trip_id = ?1") },
    // Its list of changes, and the pictures they held (their files are queued above too).
    { stmt: one("DELETE FROM files_held WHERE trip_id = ?1") },
    { stmt: one("DELETE FROM trip_change_rows WHERE change_id IN (SELECT id FROM trip_changes WHERE trip_id = ?1)") },
    { stmt: one("DELETE FROM trip_changes WHERE trip_id = ?1") },
    // Memories and every file uploaded to the trip, in a memory or not, finished or not.
    { stmt: one(`DELETE FROM memory_tags WHERE memory_id IN (${MEMORIES})`) },
    { stmt: one(`DELETE FROM memory_media WHERE memory_id IN (${MEMORIES})`) },
    { stmt: one("DELETE FROM memories WHERE trip_id = ?1") },
    { stmt: one("DELETE FROM media_objects WHERE trip_id = ?1") },
    // The boards shared by link: the links stop answering, and their files go.
    { stmt: one(`DELETE FROM collage_share_items WHERE share_id IN (${SHARES})`) },
    { stmt: one("DELETE FROM collage_shares WHERE trip_id = ?1") },
    // Money.
    { stmt: one(`DELETE FROM purchase_shares WHERE purchase_id IN (${PURCHASES})`) },
    { stmt: one("DELETE FROM purchases WHERE trip_id = ?1") },
    // The chat (notes on plans are messages in it since migration 0027), then the plan: events,
    // then the places events point at.
    { stmt: one("DELETE FROM messages WHERE trip_id = ?1") },
    // The assistant (model §20): every person's conversations about this trip and their turns go (nobody
    // can open them now), and an ask running on it. Its asks stay in the host's ledger for the month,
    // without the trip: deleting a trip doesn't hand back what the assistant cost.
    // The documents people gave the assistant on it (src/assistant/files.js): rows now, both objects of each to the drain.
    ...FILES_DELETES(env, "trip_id = ?1", [tripId], now).map((stmt) => ({ stmt })),
    { stmt: one("DELETE FROM ai_turns WHERE (user_id, conversation_id) IN (SELECT user_id, id FROM ai_conversations WHERE trip_id = ?1)") },
    { stmt: one("DELETE FROM ai_conversations WHERE trip_id = ?1") },
    { stmt: one("DELETE FROM ai_asks WHERE trip_id = ?1") },
    { stmt: one("UPDATE ai_calls SET trip_id = '' WHERE trip_id = ?1") },
    { stmt: one("DELETE FROM events WHERE trip_id = ?1") },
    // Packing: ticks and what sits in a bag, the items, the suggestions, the bags, the lists.
    { stmt: one(`DELETE FROM packing_ticks WHERE trip_id = ?1 OR item_id IN (${ITEMS})`) },
    { stmt: one(`DELETE FROM packing_placements WHERE trip_id = ?1 OR item_id IN (${ITEMS})`) },
    { stmt: one("DELETE FROM packing_items WHERE trip_id = ?1") },
    { stmt: one("DELETE FROM packing_starters WHERE trip_id = ?1") },
    { stmt: one("DELETE FROM packing_bags WHERE trip_id = ?1") },
    { stmt: one("DELETE FROM packing_lists WHERE trip_id = ?1") },
    // Where things are: places, then the areas they sit in (neighborhoods before their cities).
    { stmt: one("DELETE FROM places WHERE trip_id = ?1") },
    // The trip's reference list (0048).
    { stmt: one("DELETE FROM trip_references WHERE trip_id = ?1") },
    { stmt: one("DELETE FROM areas WHERE trip_id = ?1 AND parent IS NOT NULL") },
    { stmt: one("DELETE FROM areas WHERE trip_id = ?1") },
    // The ways in, the people, the trip.
    { stmt: one("DELETE FROM trip_links WHERE trip_id = ?1") },
    { stmt: one("DELETE FROM trip_members WHERE trip_id = ?1") },
    // The map the server cut for it (an uploaded one is a file, queued with the rest above).
    { stmt: queueFiles(env, "SELECT tiles AS r2_key, NULL AS upload_id FROM trips WHERE id = ?1 AND tiles_source = 'cut'", [tripId], now, { bucket: "tiles" }) },
    { stmt: one("DELETE FROM trips WHERE id = ?1") },
    // What went, recorded by 0036's triggers while the rows above were deleted: last, so nothing is left.
    { stmt: one("DELETE FROM trip_gone WHERE trip_id = ?1") },
    { stmt: one("DELETE FROM trip_delta_floor WHERE trip_id = ?1") },
  ];
}
