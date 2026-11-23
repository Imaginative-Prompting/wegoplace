-- 0008 — the MEDIA bucket's registry, and the byte meter.
--
-- WHY THIS EXISTS AT ALL. 0007 gave us memories/memory_media/memory_tags, which describe
-- media that is ALREADY ATTACHED TO A MEMORY. Three things happen outside that window and
-- none of them have anywhere to live in 0007:
--
--   1. A multipart upload is in flight for minutes. Between `begin` and `finish` there is an
--      R2 uploadId, a key nobody has claimed, and a user who is allowed to push parts into
--      it. Trusting the client to hand that tuple back unvalidated means any member can push
--      parts into any other member's upload; keeping it here means every part is checked
--      against the row that opened it.
--   2. An upload that finished but whose memory was never created still occupies bytes in
--      R2. Storage is the future paid tier, so the meter has to count what is actually
--      stored, not what happens to be linked. 0007's memory_media.bytes cannot see an orphan.
--   3. ORIGINAL FILENAME. `IMG_4127.HEIC` is the one string that tells a person, on the far
--      side of a round trip, that the object they got back is the object they picked. 0007 has
--      no column for it and shouldn't — it is a property of the FILE, not of the card.
--
-- Serving reads this table too: /media/<key> answers only for keys it has a row for, which
-- is what stops the bucket from being a probe surface.
--
-- 0007 IS NOT TOUCHED. No ALTER, no re-CREATE. This is additive.

CREATE TABLE IF NOT EXISTS media_objects (
  r2_key TEXT PRIMARY KEY,           -- the key in the MEDIA bucket; minted here, never by a client
  upload_id TEXT NOT NULL DEFAULT '',-- R2 multipart uploadId while state='pending', then kept for forensics
  user_id TEXT NOT NULL REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  role TEXT NOT NULL DEFAULT 'original',  -- 'original' | 'thumb'
  kind TEXT NOT NULL DEFAULT 'photo',     -- 'photo' | 'video'
  mime TEXT NOT NULL DEFAULT '',
  orig_name TEXT NOT NULL DEFAULT '',     -- exactly what the file input handed us
  bytes INTEGER NOT NULL DEFAULT 0,       -- R2's own size at complete(), never the client's claim
  sha256 TEXT NOT NULL DEFAULT '',        -- CLIENT-DECLARED. See functions/api/media.js.
  state TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'stored' | 'aborted'
  thumb_for TEXT NOT NULL DEFAULT '',     -- role='thumb': the original this is a derivative OF
  created_at INTEGER NOT NULL,
  stored_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_media_objects_user ON media_objects(user_id, state);
CREATE INDEX IF NOT EXISTS idx_media_objects_trip ON media_objects(trip_id, state);
CREATE INDEX IF NOT EXISTS idx_media_objects_thumbfor ON media_objects(thumb_for);

-- The meter. Materialised rather than derived because the paid tier reads it on every
-- upload attempt ("are you over quota?") and SUM() over every object a heavy user owns is
-- the wrong shape for that. It is maintained in the same D1 batch as the media_objects
-- insert/delete, and GET /api/media/usage returns the derived SUM alongside it so drift is
-- visible rather than silent.
CREATE TABLE IF NOT EXISTS media_usage (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  bytes INTEGER NOT NULL DEFAULT 0,
  objects INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
