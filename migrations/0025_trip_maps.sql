-- A trip's offline map, made for any destination (model §5 "Map"; docs/map-options.md, option 1;
-- src/map/). `trips.tiles` already names the archive in the TILES bucket; this adds what the app
-- and the people on the trip need to know about it:
--
--   * tiles_state: none (no map: the app draws its own ground), cutting (being made from the world
--     build after the trip's areas changed), ready, failed (tiles_note says why; the last good map,
--     if any, stays in use).
--   * tiles_source: cut (made by the server from the trip's regions), upload (a person put an
--     archive in through a one-use link: it counts against the host's storage), set (named by hand,
--     as the first trip's was at the cutover).
--   * tiles_version: changes with each new map, so a phone knows to keep the new one; tiles_bytes,
--     its size (a phone asks before keeping an uploaded one over its budget); tiles_at, when it was
--     made; tiles_glyphs, the 256-character ranges its labels' text uses (JSON), so a phone fetches
--     the label fonts it needs before it loses signal; tiles_note, what to tell people (a region
--     left out to fit the budget, or why a cut failed).
--
-- The trip row's change trigger is made again to record the new columns (check:changes); an undo
-- still puts back only the trip's own fields. Applied as ONE file after 0024.

ALTER TABLE trips ADD COLUMN tiles_state TEXT NOT NULL DEFAULT 'none' CHECK (tiles_state IN ('none', 'cutting', 'ready', 'failed'));
ALTER TABLE trips ADD COLUMN tiles_source TEXT CHECK (tiles_source IN ('cut', 'upload', 'set'));
ALTER TABLE trips ADD COLUMN tiles_version TEXT;
ALTER TABLE trips ADD COLUMN tiles_bytes INTEGER;
ALTER TABLE trips ADD COLUMN tiles_at INTEGER;
ALTER TABLE trips ADD COLUMN tiles_glyphs TEXT;
ALTER TABLE trips ADD COLUMN tiles_note TEXT NOT NULL DEFAULT '';
UPDATE trips SET tiles_state = 'ready', tiles_source = 'set', tiles_version = tiles WHERE tiles IS NOT NULL;

DROP TRIGGER changes_trips_update;
CREATE TRIGGER changes_trips_update AFTER UPDATE ON trips WHEN EXISTS (SELECT 1 FROM change_open) AND (OLD.name IS NOT NEW.name OR OLD.starts_on IS NOT NEW.starts_on OR OLD.ends_on IS NOT NEW.ends_on OR OLD.default_tz IS NOT NEW.default_tz OR OLD.currencies IS NOT NEW.currencies OR OLD.interests IS NOT NEW.interests)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'trips', json_array(NEW.id), NULL, json_object('id', OLD.id, 'name', OLD.name, 'starts_on', OLD.starts_on, 'ends_on', OLD.ends_on, 'default_tz', OLD.default_tz, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'collage_seed', OLD.collage_seed, 'collage_version', OLD.collage_version, 'currencies', OLD.currencies, 'host_id', OLD.host_id, 'updated_at', OLD.updated_at, 'rev', OLD.rev, 'interests', OLD.interests, 'tiles', OLD.tiles, 'data_rev', OLD.data_rev, 'message_seq', OLD.message_seq, 'tiles_state', OLD.tiles_state, 'tiles_source', OLD.tiles_source, 'tiles_version', OLD.tiles_version, 'tiles_bytes', OLD.tiles_bytes, 'tiles_at', OLD.tiles_at, 'tiles_glyphs', OLD.tiles_glyphs, 'tiles_note', OLD.tiles_note), json_object('id', NEW.id, 'name', NEW.name, 'starts_on', NEW.starts_on, 'ends_on', NEW.ends_on, 'default_tz', NEW.default_tz, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'collage_seed', NEW.collage_seed, 'collage_version', NEW.collage_version, 'currencies', NEW.currencies, 'host_id', NEW.host_id, 'updated_at', NEW.updated_at, 'rev', NEW.rev, 'interests', NEW.interests, 'tiles', NEW.tiles, 'data_rev', NEW.data_rev, 'message_seq', NEW.message_seq, 'tiles_state', NEW.tiles_state, 'tiles_source', NEW.tiles_source, 'tiles_version', NEW.tiles_version, 'tiles_bytes', NEW.tiles_bytes, 'tiles_at', NEW.tiles_at, 'tiles_glyphs', NEW.tiles_glyphs, 'tiles_note', NEW.tiles_note) FROM change_open;
END;
