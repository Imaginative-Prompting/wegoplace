-- The trip's chat (model §17; src/api/messages.js), and the split of a trip's rev.
--
--   * messages: one chat per trip. A message has its author, its words (1 to 4,000 characters),
--     the server's order (`seq`, per trip: the chat's counter, trips.message_seq, moves by one in
--     every chat write, and a new message takes it), `touched` (the counter at its last change: an
--     edit or a delete moves it, so a phone asking for what changed after N gets those too), and may be
--     ABOUT one thing in the trip: an event, a place or a purchase (`about_kind`, `about_id`), with
--     `about_part` 'before' for the empty time before an event (what a "gap" note was), and
--     `about_name`, the thing's name when the message was written, kept if the thing goes. The
--     author may change the words (`edited_at` says so); the author, or the trip's host, may
--     delete one: the words are cleared and `deleted_at`/`deleted_by` stay, so a line says one
--     was deleted. The id is the sender's, so a queued message sent twice lands once.
--   * trips.data_rev: the trip's rev as of its last write that wasn't the chat's, and
--     trips.message_seq: the chat's counter (its last write's). `rev` still moves on both, so a client that
--     reads only `rev` works as before; one that reads all three reads the whole trip only when
--     data_rev moves, and only the new messages when message_seq does (docs/API.md).
--   * trip_members.chat_muted: a person's choice to hear nothing of a trip's chat (sent nothing
--     until the app has push notifications).
--
-- The trip row's change trigger is made again to record the two new columns (check:changes
-- holds each trigger to its table's columns); an undo still puts back only the trip's own
-- fields, never its counters. Applied as ONE file after 0023.

ALTER TABLE trips ADD COLUMN data_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN message_seq INTEGER NOT NULL DEFAULT 0;
UPDATE trips SET data_rev = rev;

ALTER TABLE trip_members ADD COLUMN chat_muted INTEGER NOT NULL DEFAULT 0;

CREATE TABLE messages (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  touched INTEGER NOT NULL,
  author TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  about_kind TEXT CHECK (about_kind IN ('event', 'place', 'purchase')),
  about_id TEXT,
  about_part TEXT CHECK (about_part IN ('before')),
  about_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  deleted_by TEXT,
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, id),
  UNIQUE (trip_id, seq),
  CHECK ((about_kind IS NULL) = (about_id IS NULL)),
  CHECK (about_part IS NULL OR about_kind = 'event')
);
CREATE INDEX idx_messages_about ON messages(trip_id, about_kind, about_id);
CREATE INDEX idx_messages_author_time ON messages(trip_id, author, created_at);
CREATE INDEX idx_messages_touched ON messages(trip_id, touched);

DROP TRIGGER changes_trips_update;
CREATE TRIGGER changes_trips_update AFTER UPDATE ON trips WHEN EXISTS (SELECT 1 FROM change_open) AND (OLD.name IS NOT NEW.name OR OLD.starts_on IS NOT NEW.starts_on OR OLD.ends_on IS NOT NEW.ends_on OR OLD.default_tz IS NOT NEW.default_tz OR OLD.currencies IS NOT NEW.currencies OR OLD.interests IS NOT NEW.interests)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'trips', json_array(NEW.id), NULL, json_object('id', OLD.id, 'name', OLD.name, 'starts_on', OLD.starts_on, 'ends_on', OLD.ends_on, 'default_tz', OLD.default_tz, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'collage_seed', OLD.collage_seed, 'collage_version', OLD.collage_version, 'currencies', OLD.currencies, 'host_id', OLD.host_id, 'updated_at', OLD.updated_at, 'rev', OLD.rev, 'interests', OLD.interests, 'tiles', OLD.tiles, 'data_rev', OLD.data_rev, 'message_seq', OLD.message_seq), json_object('id', NEW.id, 'name', NEW.name, 'starts_on', NEW.starts_on, 'ends_on', NEW.ends_on, 'default_tz', NEW.default_tz, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'collage_seed', NEW.collage_seed, 'collage_version', NEW.collage_version, 'currencies', NEW.currencies, 'host_id', NEW.host_id, 'updated_at', NEW.updated_at, 'rev', NEW.rev, 'interests', NEW.interests, 'tiles', NEW.tiles, 'data_rev', NEW.data_rev, 'message_seq', NEW.message_seq) FROM change_open;
END;
