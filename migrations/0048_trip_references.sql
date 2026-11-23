-- 0048: a trip's reference list (src/api/references.js, js/references.js): short notes the whole group needs at hand
-- that belong to no day and no place (money and ATMs, emergency numbers, the embassy, a door code). Anyone on the trip
-- reads, adds, changes and removes them, as plans. Sent with the trip's snapshot (its key "references"), gone with the
-- trip (src/trips/delete.js), and recorded by the changes' triggers so an AI's write has its undo (0023's pattern).
--   trip_references.id          chosen by whoever adds it (the app's "rf-…", an AI's own)
--   trip_references.title       at most REFERENCE_TITLE_MAX characters (public/js/shared/limits.js)
--   trip_references.body        at most REFERENCE_TEXT_MAX; line breaks kept; '' when there is none
--   trip_references.position    the list's order, low first
--   trip_references.created_by  the account that added it, or NULL when that account is gone
--   created_at, updated_at      seconds; rev the trip's rev when it was last written
-- A new table only the new Worker reads: it may go before the deploy. Only CREATEs.
CREATE TABLE trip_references (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  position REAL NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, id)
);
CREATE INDEX trip_references_by_rev ON trip_references (trip_id, rev);

-- What went, for a phone asking since its last (0036's pattern).
CREATE TRIGGER gone_trip_references AFTER DELETE ON trip_references BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'trip_references', OLD.id, NULL, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;

-- An AI's write, recorded while a change is open (0023's pattern; every column, so an undo puts the row back whole).
CREATE TRIGGER changes_trip_references_insert AFTER INSERT ON trip_references WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'trip_references', json_array(NEW.trip_id, NEW.id), NULL, NULL, json_object('trip_id', NEW.trip_id, 'id', NEW.id, 'title', NEW.title, 'body', NEW.body, 'position', NEW.position, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_trip_references_update AFTER UPDATE ON trip_references WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'trip_references', json_array(NEW.trip_id, NEW.id), NULL, json_object('trip_id', OLD.trip_id, 'id', OLD.id, 'title', OLD.title, 'body', OLD.body, 'position', OLD.position, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'rev', OLD.rev), json_object('trip_id', NEW.trip_id, 'id', NEW.id, 'title', NEW.title, 'body', NEW.body, 'position', NEW.position, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_trip_references_delete AFTER DELETE ON trip_references WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'trip_references', json_array(OLD.trip_id, OLD.id), NULL, json_object('trip_id', OLD.trip_id, 'id', OLD.id, 'title', OLD.title, 'body', OLD.body, 'position', OLD.position, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'rev', OLD.rev), NULL FROM change_open;
END;
