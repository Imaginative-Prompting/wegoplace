// Letting go of a trip's map, in the batch that replaces it: a cut one goes to the drain (TILES);
// an uploaded one's file row goes and its file to the drain (MEDIA), so the host's storage frees.

import { queueFiles } from "../trips/drain.js";

/** Statements that let go of the trip's current map: a cut one to the drain, an uploaded one's file row and file. */
export function dropMapSteps(env, tripId, now) {
  return [
    queueFiles(env, "SELECT tiles AS r2_key, NULL AS upload_id FROM trips WHERE id = ?1 AND tiles_source = 'cut'", [tripId], now, { bucket: "tiles" }),
    queueFiles(env, "SELECT o.r2_key, NULL AS upload_id FROM media_objects o JOIN trips t ON t.tiles = o.r2_key WHERE t.id = ?1 AND t.tiles_source = 'upload' AND o.role = 'map'", [tripId], now),
    env.DB.prepare("DELETE FROM media_objects WHERE role = 'map' AND r2_key = (SELECT tiles FROM trips WHERE id = ?1 AND tiles_source = 'upload')").bind(tripId),
  ];
}

