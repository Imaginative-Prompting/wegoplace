-- 0034: the host turns the assistant off for one trip (docs/model.md §20: "The host can turn the
-- assistant off for one trip", their answer to one person spending the month). 1: off. Read only by the
-- routes of the assistant (src/assistant/talk.js), never in the snapshot of the trip; 0 for every trip there is.
ALTER TABLE trips ADD COLUMN assistant_off INTEGER NOT NULL DEFAULT 0;

-- trips is a table a change records (0023): its update trigger names every column, this one too
-- (tools/change-triggers.mjs --upto 0034; check:changes holds it). It fires only on the details of the trip, as before.
DROP TRIGGER changes_trips_update;
CREATE TRIGGER changes_trips_update AFTER UPDATE ON trips WHEN EXISTS (SELECT 1 FROM change_open) AND (OLD.name IS NOT NEW.name OR OLD.starts_on IS NOT NEW.starts_on OR OLD.ends_on IS NOT NEW.ends_on OR OLD.default_tz IS NOT NEW.default_tz OR OLD.currencies IS NOT NEW.currencies OR OLD.interests IS NOT NEW.interests)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'trips', json_array(NEW.id), NULL, json_object('id', OLD.id, 'name', OLD.name, 'starts_on', OLD.starts_on, 'ends_on', OLD.ends_on, 'default_tz', OLD.default_tz, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'collage_seed', OLD.collage_seed, 'collage_version', OLD.collage_version, 'currencies', OLD.currencies, 'host_id', OLD.host_id, 'updated_at', OLD.updated_at, 'rev', OLD.rev, 'interests', OLD.interests, 'tiles', OLD.tiles, 'data_rev', OLD.data_rev, 'message_seq', OLD.message_seq, 'tiles_state', OLD.tiles_state, 'tiles_source', OLD.tiles_source, 'tiles_version', OLD.tiles_version, 'tiles_bytes', OLD.tiles_bytes, 'tiles_at', OLD.tiles_at, 'tiles_glyphs', OLD.tiles_glyphs, 'tiles_note', OLD.tiles_note, 'assistant_off', OLD.assistant_off), json_object('id', NEW.id, 'name', NEW.name, 'starts_on', NEW.starts_on, 'ends_on', NEW.ends_on, 'default_tz', NEW.default_tz, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'collage_seed', NEW.collage_seed, 'collage_version', NEW.collage_version, 'currencies', NEW.currencies, 'host_id', NEW.host_id, 'updated_at', NEW.updated_at, 'rev', NEW.rev, 'interests', NEW.interests, 'tiles', NEW.tiles, 'data_rev', NEW.data_rev, 'message_seq', NEW.message_seq, 'tiles_state', NEW.tiles_state, 'tiles_source', NEW.tiles_source, 'tiles_version', NEW.tiles_version, 'tiles_bytes', NEW.tiles_bytes, 'tiles_at', NEW.tiles_at, 'tiles_glyphs', NEW.tiles_glyphs, 'tiles_note', NEW.tiles_note, 'assistant_off', NEW.assistant_off) FROM change_open;
END;
