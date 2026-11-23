// Files whose rows are gone, removed from the bucket afterwards.
//
// Whatever deletes rows that name stored files (a trip, an account, a memory, a board, an
// upload someone cancelled) puts the files' keys into `files_to_delete` IN THE SAME BATCH
// (queueFiles below), so a row and its file can't come apart: the row is gone and its file is
// queued, or neither. The bytes stop counting at that moment, because what counts is read from
// the rows (src/trips/storage.js). A file whose row is gone is served to nobody.
//
// The scheduled handler (src/index.js, a cron in wrangler.jsonc) runs drain():
//   0. changes older than CHANGE_DAYS go (src/trips/changes.js), and the picture files only they
//      held are queued;
//   1. an upload under way past its reservation is abandoned: its row goes and its upload is
//      queued to be aborted;
//   2. up to DRAIN_BATCH queued files are removed: unfinished uploads aborted one by one, the
//      rest deleted in one call (and one by one if that call fails, so one bad key doesn't hold
//      the rest);
//   3. a file that fails stays queued with its error and a count of tries. After
//      DRAIN_TRIES_MAX it is left alone, for a person to look at, and every run says how many
//      such files there are (a console.error line, and drain's answer), so it never fails
//      silently.

import { DRAIN_BATCH, DRAIN_TRIES_MAX, GONE_DAYS, RESERVATION_SECONDS } from "../../public/js/shared/limits.js";
import { expireChanges } from "./changes.js";
import { sweepReading } from "../assistant/files.js";

/**
 * A statement that queues the keys a SELECT names, for one batch. `select` answers columns
 * `r2_key` and `upload_id` (NULL for a finished file); `params` are its parameters, with the
 * time bound after them.
 */
export function queueFiles(env, select, params, now, { bucket = "media" } = {}) {
  const at = params.length + 1;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO files_to_delete (bucket, r2_key, upload_id, queued_at)
     SELECT '${bucket === "tiles" ? "tiles" : "media"}', k.r2_key, k.upload_id, ?${at} FROM (${select}) k WHERE k.r2_key IS NOT NULL AND k.r2_key != ''`,
  ).bind(...params, now);
  stmt.queues = true;     // so a caller can count, from the batch's answers, what it queued
  return stmt;
}

/** One run. Answers what it did, and how many files have stopped for a person to look at. */
export async function drain(env, now = Math.floor(Date.now() / 1000)) {
  const db = env.DB;
  // 0. Changes past their days (src/trips/changes.js): they go, and the pictures only they held
  //    are queued with the rest.
  const expired = await expireChanges(env, now);
  // 0b. What went, past its days (0036): the lines go, and each trip's floor moves up to them, so a phone
  //     further behind than that reads the whole trip (src/api/trip.js, since=).
  await db.batch([
    db.prepare(`INSERT INTO trip_delta_floor (trip_id, rev) SELECT trip_id, MAX(rev) FROM trip_gone WHERE at < ?1 GROUP BY trip_id
      ON CONFLICT(trip_id) DO UPDATE SET rev = MAX(trip_delta_floor.rev, excluded.rev)`).bind(now - GONE_DAYS * 86400),
    db.prepare("DELETE FROM trip_gone WHERE at < ?1").bind(now - GONE_DAYS * 86400),
    // Exports past their hour count for nothing: kept a day.
    db.prepare("DELETE FROM account_exports WHERE at < ?1").bind(now - 86400),
    // So are guests made and rejoin links (0040).
    db.prepare("DELETE FROM hour_counts WHERE at < ?1").bind(now - 86400),
  ]);
  // 1. Uploads abandoned past their reservation.
  const cut = now - RESERVATION_SECONDS;
  const [, abandoned] = await db.batch([
    queueFiles(env, "SELECT r2_key, NULLIF(upload_id, '') AS upload_id FROM media_objects WHERE state = 'pending' AND created_at <= ?1", [cut], now),
    db.prepare("DELETE FROM media_objects WHERE state = 'pending' AND created_at <= ?1").bind(cut),
  ]);

  // 1b. Documents given the assistant whose reading never finished (their Worker gone): settled, so the room lets go of
  //     what their text was held at (src/assistant/files.js sweepReading).
  const reading = env.MEDIA ? await sweepReading(env, now) : { settled: 0, gone: 0 };

  // 2. The queue, bucket by bucket: files (MEDIA), and trips' maps the server cut (TILES).
  const done = [];
  const failed = [];
  for (const [bucket, store] of [["media", env.MEDIA], ["tiles", env.TILES]]) {
    if (!store) continue;
    const rows = (await db.prepare(
      "SELECT r2_key, upload_id FROM files_to_delete WHERE bucket = ?3 AND attempts < ?1 ORDER BY queued_at, r2_key LIMIT ?2",
    ).bind(DRAIN_TRIES_MAX, DRAIN_BATCH, bucket).all()).results || [];
    const gone = [];
    const broke = [];
    for (const r of rows.filter((x) => x.upload_id)) {
      try {
        await store.resumeMultipartUpload(r.r2_key, r.upload_id).abort();
        gone.push(r.r2_key);
      } catch (e) {
        // An upload that finished after all leaves an object behind: delete that instead.
        try { await store.delete(r.r2_key); gone.push(r.r2_key); } catch { broke.push([r.r2_key, String(e?.message || e)]); }
      }
    }
    const plain = rows.filter((x) => !x.upload_id).map((x) => x.r2_key);
    if (plain.length) {
      try {
        await store.delete(plain);
        gone.push(...plain);
      } catch {
        for (const key of plain) {
          try { await store.delete(key); gone.push(key); } catch (e) { broke.push([key, String(e?.message || e)]); }
        }
      }
    }
    const writes = [];
    for (let i = 0; i < gone.length; i += 90) {
      const chunk = gone.slice(i, i + 90);
      writes.push(db.prepare("DELETE FROM files_to_delete WHERE bucket = ?2 AND r2_key IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(chunk), bucket));
    }
    for (const [key, error] of broke) {
      writes.push(db.prepare("UPDATE files_to_delete SET attempts = attempts + 1, last_error = ?2 WHERE bucket = ?3 AND r2_key = ?1").bind(key, error.slice(0, 300), bucket));
    }
    if (writes.length) await db.batch(writes);
    done.push(...gone);
    failed.push(...broke);
  }

  // 3. What has stopped.
  const stuck = (await db.prepare("SELECT COUNT(*) AS n FROM files_to_delete WHERE attempts >= ?1").bind(DRAIN_TRIES_MAX).first())?.n ?? 0;
  if (stuck) console.error(`files_to_delete: ${stuck} file(s) failed ${DRAIN_TRIES_MAX} runs and wait for a person (SELECT * FROM files_to_delete WHERE attempts >= ${DRAIN_TRIES_MAX})`);
  return { expired: expired.changes, abandoned: abandoned.meta.changes, reading, removed: done.length, failed: failed.length, stuck };
}
