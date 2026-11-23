-- 0042: an upload's own id, chosen by the phone that begins it (src/api/media.js begin). A begin sent again, its
-- answer lost on the way, names the same id and is handed the upload the first one opened, so the file's room is held
-- once, not twice for a day.
--   media_objects.begin_id   the phone's id for that upload: lowercase letters, digits, hyphens and underscores
--                            (public/js/shared/trip-rules.js readNewId); NULL for a begin that named none
-- Looked up by the person and the trip it was begun in, and only while the upload is under way.
-- A column with no default that only the new route reads: an old Worker reads past it, so it may go before the deploy.
ALTER TABLE media_objects ADD COLUMN begin_id TEXT;
CREATE INDEX media_objects_begin ON media_objects (trip_id, user_id, begin_id) WHERE begin_id IS NOT NULL;
