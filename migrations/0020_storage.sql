-- 0020: storage. A free account holds 1 GiB across every trip it hosts (model §7).
--
-- WHAT A HOST USES is read from the rows, never kept as a number (src/trips/storage.js): the
-- files of the trips they host (originals and thumbnails, stored, and uploads still under way
-- for the day they may take), and the boards shared from those trips that aren't revoked.
-- Handing a trip over, deleting one or revoking a board is right by construction, and files no
-- row names count against nobody. So `media_usage`, the per-uploader counter, goes.
--
--   * `trip_handovers`: a trip offered to a member, who accepts or declines (model §4). One
--     offer a trip at a time; nothing changes until it is accepted.
--   * `files_to_delete`: the files whose rows are gone, for the scheduled drain to remove from
--     the bucket (an unfinished upload carries its upload_id, to be aborted). A key that keeps
--     failing stays, counted, for a person to look at.
--   * `trips.tiles`: the key of the trip's offline map archive, or NULL for none.
--   * `collage_share_items.memory_id`: the memory a board's photograph came from, so deleting
--     the memory takes it out of the boards it is on. Older items don't know theirs.
--
-- Run it as one file, once (`ALTER TABLE … ADD COLUMN` can't be run twice).

CREATE TABLE trip_handovers (
  trip_id TEXT PRIMARY KEY REFERENCES trips(id),
  to_user TEXT NOT NULL REFERENCES users(id),
  offered_by TEXT NOT NULL REFERENCES users(id),
  offered_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE files_to_delete (
  bucket TEXT NOT NULL,             -- 'media'
  r2_key TEXT NOT NULL,
  upload_id TEXT,                   -- an unfinished multipart upload to abort, or NULL
  queued_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (bucket, r2_key)
);
CREATE INDEX idx_files_to_delete_queue ON files_to_delete(attempts, queued_at);

ALTER TABLE trips ADD COLUMN tiles TEXT;
ALTER TABLE collage_share_items ADD COLUMN memory_id TEXT;

DROP TABLE media_usage;

CREATE INDEX idx_media_objects_trip_created ON media_objects(trip_id, state, created_at);
CREATE INDEX idx_share_items_memory ON collage_share_items(memory_id);
