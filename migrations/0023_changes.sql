-- Changes an AI makes, and undoing them (model §9; src/trips/changes.js).
--
-- Every write through the MCP is one change: who asked, the app it came from, when, its one-line
-- summary, and each row it touched, before and after, as JSON of the row's columns. The rows are
-- recorded by the triggers at the end of this file, which record only while `change_open` holds
-- a change's id. src/trips/rev.js write() opens the change first in its batch and closes it last
-- when a request carries one, so a change's record is exactly its write, in the same
-- transaction, and an edit made by hand in the app is never recorded.
--
--   * trip_changes: a change's line. `kind` is 'write', 'undo' (undo_of names the change it
--     undid) or 'create' (a trip made through the MCP: a line with no rows and no undo). Kept
--     30 days (CHANGE_DAYS, public/js/shared/limits.js), then removed by the cron.
--   * trip_change_rows: what it wrote, in order (`seq`). `row_key` is the row's primary key as a
--     JSON array; `private_to` is the person whose own row it is (their packing things), else
--     NULL; `before` NULL for a row added, `after` NULL for a row removed.
--   * change_open: the change being written, inside a write's batch only; empty otherwise.
--   * files_held: a picture's file that a change replaced or removed. Its media_objects row stays
--     stored and counted to the host, so the change's undo can put the picture back; the cron
--     frees it when the change goes (or the host clears the list).
--   * revoked_grants: AI apps disconnected (below).
--   * picture_links gains the change a one-use upload link's picture is written under, when an
--     AI made the link: its app and summary.
--
-- The triggers are written from the schema by tools/change-triggers.mjs; check:changes holds
-- them to it (every table of a trip's rows has them or is named as one no tool writes, and each
-- records its table's columns exactly).
--
-- Applied as ONE file after 0022. It runs through `wrangler d1 execute --file` as it is: each
-- trigger's body is one statement between BEGIN and END.
CREATE TABLE trip_changes (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  summary TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('write', 'undo', 'create')),
  undo_of TEXT,
  rev INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX trip_changes_by_trip ON trip_changes (trip_id, created_at);
CREATE INDEX trip_changes_by_undo ON trip_changes (undo_of) WHERE undo_of IS NOT NULL;

CREATE TABLE trip_change_rows (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL REFERENCES trip_changes(id),
  tbl TEXT NOT NULL,
  row_key TEXT NOT NULL,
  private_to TEXT,
  before TEXT,
  after TEXT
);
CREATE INDEX trip_change_rows_by_change ON trip_change_rows (change_id, seq);

CREATE TABLE change_open (
  change_id TEXT PRIMARY KEY
);

CREATE TABLE files_held (
  r2_key TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  held_at INTEGER NOT NULL
);
CREATE INDEX files_held_by_change ON files_held (change_id);
CREATE INDEX files_held_by_trip ON files_held (trip_id);

-- An AI app's connection its person disconnected (src/mcp/oauth.js): a hash of the account's id
-- and the grant's, and when. Checked on every /token answer and /mcp request, so a connection
-- stays disconnected whatever the provider's store still holds. Kept 90 days, the refresh
-- tokens' lifetime; it names no one, so it stays when the account goes.
CREATE TABLE revoked_grants (
  grant_hash TEXT PRIMARY KEY,
  revoked_at INTEGER NOT NULL
);

ALTER TABLE picture_links ADD COLUMN change_source TEXT;
ALTER TABLE picture_links ADD COLUMN change_summary TEXT;

CREATE TRIGGER changes_trips_update AFTER UPDATE ON trips WHEN EXISTS (SELECT 1 FROM change_open) AND (OLD.name IS NOT NEW.name OR OLD.starts_on IS NOT NEW.starts_on OR OLD.ends_on IS NOT NEW.ends_on OR OLD.default_tz IS NOT NEW.default_tz OR OLD.currencies IS NOT NEW.currencies OR OLD.interests IS NOT NEW.interests)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'trips', json_array(NEW.id), NULL, json_object('id', OLD.id, 'name', OLD.name, 'starts_on', OLD.starts_on, 'ends_on', OLD.ends_on, 'default_tz', OLD.default_tz, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'collage_seed', OLD.collage_seed, 'collage_version', OLD.collage_version, 'currencies', OLD.currencies, 'host_id', OLD.host_id, 'updated_at', OLD.updated_at, 'rev', OLD.rev, 'interests', OLD.interests, 'tiles', OLD.tiles), json_object('id', NEW.id, 'name', NEW.name, 'starts_on', NEW.starts_on, 'ends_on', NEW.ends_on, 'default_tz', NEW.default_tz, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'collage_seed', NEW.collage_seed, 'collage_version', NEW.collage_version, 'currencies', NEW.currencies, 'host_id', NEW.host_id, 'updated_at', NEW.updated_at, 'rev', NEW.rev, 'interests', NEW.interests, 'tiles', NEW.tiles) FROM change_open;
END;

CREATE TRIGGER changes_areas_insert AFTER INSERT ON areas WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'areas', json_array(NEW.trip_id, NEW.id), NULL, NULL, json_object('trip_id', NEW.trip_id, 'id', NEW.id, 'name', NEW.name, 'parent', NEW.parent, 'west', NEW.west, 'south', NEW.south, 'east', NEW.east, 'north', NEW.north, 'sort', NEW.sort, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_areas_update AFTER UPDATE ON areas WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'areas', json_array(NEW.trip_id, NEW.id), NULL, json_object('trip_id', OLD.trip_id, 'id', OLD.id, 'name', OLD.name, 'parent', OLD.parent, 'west', OLD.west, 'south', OLD.south, 'east', OLD.east, 'north', OLD.north, 'sort', OLD.sort, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'rev', OLD.rev), json_object('trip_id', NEW.trip_id, 'id', NEW.id, 'name', NEW.name, 'parent', NEW.parent, 'west', NEW.west, 'south', NEW.south, 'east', NEW.east, 'north', NEW.north, 'sort', NEW.sort, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_areas_delete AFTER DELETE ON areas WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'areas', json_array(OLD.trip_id, OLD.id), NULL, json_object('trip_id', OLD.trip_id, 'id', OLD.id, 'name', OLD.name, 'parent', OLD.parent, 'west', OLD.west, 'south', OLD.south, 'east', OLD.east, 'north', OLD.north, 'sort', OLD.sort, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'rev', OLD.rev), NULL FROM change_open;
END;

CREATE TRIGGER changes_places_insert AFTER INSERT ON places WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'places', json_array(NEW.trip_id, NEW.id), NULL, NULL, json_object('trip_id', NEW.trip_id, 'id', NEW.id, 'name', NEW.name, 'name_local', NEW.name_local, 'kind', NEW.kind, 'subkind', NEW.subkind, 'area', NEW.area, 'address', NEW.address, 'address_note', NEW.address_note, 'lat', NEW.lat, 'lng', NEW.lng, 'gmaps_place_id', NEW.gmaps_place_id, 'rating', NEW.rating, 'rating_count', NEW.rating_count, 'price_level', NEW.price_level, 'hours', NEW.hours, 'phone', NEW.phone, 'website', NEW.website, 'why', NEW.why, 'notes', NEW.notes, 'tags', NEW.tags, 'near_anchor', NEW.near_anchor, 'walk_minutes', NEW.walk_minutes, 'confidence', NEW.confidence, 'source', NEW.source, 'is_anchor', NEW.is_anchor, 'verified_at', NEW.verified_at, 'image_url', NEW.image_url, 'image_credit', NEW.image_credit, 'image_license', NEW.image_license, 'image_source', NEW.image_source, 'elevation_m', NEW.elevation_m, 'checkout', NEW.checkout, 'created_by', NEW.created_by, 'updated_at', NEW.updated_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_places_update AFTER UPDATE ON places WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'places', json_array(NEW.trip_id, NEW.id), NULL, json_object('trip_id', OLD.trip_id, 'id', OLD.id, 'name', OLD.name, 'name_local', OLD.name_local, 'kind', OLD.kind, 'subkind', OLD.subkind, 'area', OLD.area, 'address', OLD.address, 'address_note', OLD.address_note, 'lat', OLD.lat, 'lng', OLD.lng, 'gmaps_place_id', OLD.gmaps_place_id, 'rating', OLD.rating, 'rating_count', OLD.rating_count, 'price_level', OLD.price_level, 'hours', OLD.hours, 'phone', OLD.phone, 'website', OLD.website, 'why', OLD.why, 'notes', OLD.notes, 'tags', OLD.tags, 'near_anchor', OLD.near_anchor, 'walk_minutes', OLD.walk_minutes, 'confidence', OLD.confidence, 'source', OLD.source, 'is_anchor', OLD.is_anchor, 'verified_at', OLD.verified_at, 'image_url', OLD.image_url, 'image_credit', OLD.image_credit, 'image_license', OLD.image_license, 'image_source', OLD.image_source, 'elevation_m', OLD.elevation_m, 'checkout', OLD.checkout, 'created_by', OLD.created_by, 'updated_at', OLD.updated_at, 'rev', OLD.rev), json_object('trip_id', NEW.trip_id, 'id', NEW.id, 'name', NEW.name, 'name_local', NEW.name_local, 'kind', NEW.kind, 'subkind', NEW.subkind, 'area', NEW.area, 'address', NEW.address, 'address_note', NEW.address_note, 'lat', NEW.lat, 'lng', NEW.lng, 'gmaps_place_id', NEW.gmaps_place_id, 'rating', NEW.rating, 'rating_count', NEW.rating_count, 'price_level', NEW.price_level, 'hours', NEW.hours, 'phone', NEW.phone, 'website', NEW.website, 'why', NEW.why, 'notes', NEW.notes, 'tags', NEW.tags, 'near_anchor', NEW.near_anchor, 'walk_minutes', NEW.walk_minutes, 'confidence', NEW.confidence, 'source', NEW.source, 'is_anchor', NEW.is_anchor, 'verified_at', NEW.verified_at, 'image_url', NEW.image_url, 'image_credit', NEW.image_credit, 'image_license', NEW.image_license, 'image_source', NEW.image_source, 'elevation_m', NEW.elevation_m, 'checkout', NEW.checkout, 'created_by', NEW.created_by, 'updated_at', NEW.updated_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_places_delete AFTER DELETE ON places WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'places', json_array(OLD.trip_id, OLD.id), NULL, json_object('trip_id', OLD.trip_id, 'id', OLD.id, 'name', OLD.name, 'name_local', OLD.name_local, 'kind', OLD.kind, 'subkind', OLD.subkind, 'area', OLD.area, 'address', OLD.address, 'address_note', OLD.address_note, 'lat', OLD.lat, 'lng', OLD.lng, 'gmaps_place_id', OLD.gmaps_place_id, 'rating', OLD.rating, 'rating_count', OLD.rating_count, 'price_level', OLD.price_level, 'hours', OLD.hours, 'phone', OLD.phone, 'website', OLD.website, 'why', OLD.why, 'notes', OLD.notes, 'tags', OLD.tags, 'near_anchor', OLD.near_anchor, 'walk_minutes', OLD.walk_minutes, 'confidence', OLD.confidence, 'source', OLD.source, 'is_anchor', OLD.is_anchor, 'verified_at', OLD.verified_at, 'image_url', OLD.image_url, 'image_credit', OLD.image_credit, 'image_license', OLD.image_license, 'image_source', OLD.image_source, 'elevation_m', OLD.elevation_m, 'checkout', OLD.checkout, 'created_by', OLD.created_by, 'updated_at', OLD.updated_at, 'rev', OLD.rev), NULL FROM change_open;
END;

CREATE TRIGGER changes_events_insert AFTER INSERT ON events WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'events', json_array(NEW.trip_id, NEW.id), NULL, NULL, json_object('trip_id', NEW.trip_id, 'id', NEW.id, 'starts_at', NEW.starts_at, 'ends_at', NEW.ends_at, 'tz', NEW.tz, 'end_tz', NEW.end_tz, 'all_day', NEW.all_day, 'title', NEW.title, 'kind', NEW.kind, 'place_id', NEW.place_id, 'detail', NEW.detail, 'url', NEW.url, 'source', NEW.source, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'image_url', NEW.image_url, 'image_credit', NEW.image_credit, 'image_license', NEW.image_license, 'image_source', NEW.image_source, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_events_update AFTER UPDATE ON events WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'events', json_array(NEW.trip_id, NEW.id), NULL, json_object('trip_id', OLD.trip_id, 'id', OLD.id, 'starts_at', OLD.starts_at, 'ends_at', OLD.ends_at, 'tz', OLD.tz, 'end_tz', OLD.end_tz, 'all_day', OLD.all_day, 'title', OLD.title, 'kind', OLD.kind, 'place_id', OLD.place_id, 'detail', OLD.detail, 'url', OLD.url, 'source', OLD.source, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'image_url', OLD.image_url, 'image_credit', OLD.image_credit, 'image_license', OLD.image_license, 'image_source', OLD.image_source, 'rev', OLD.rev), json_object('trip_id', NEW.trip_id, 'id', NEW.id, 'starts_at', NEW.starts_at, 'ends_at', NEW.ends_at, 'tz', NEW.tz, 'end_tz', NEW.end_tz, 'all_day', NEW.all_day, 'title', NEW.title, 'kind', NEW.kind, 'place_id', NEW.place_id, 'detail', NEW.detail, 'url', NEW.url, 'source', NEW.source, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'image_url', NEW.image_url, 'image_credit', NEW.image_credit, 'image_license', NEW.image_license, 'image_source', NEW.image_source, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_events_delete AFTER DELETE ON events WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'events', json_array(OLD.trip_id, OLD.id), NULL, json_object('trip_id', OLD.trip_id, 'id', OLD.id, 'starts_at', OLD.starts_at, 'ends_at', OLD.ends_at, 'tz', OLD.tz, 'end_tz', OLD.end_tz, 'all_day', OLD.all_day, 'title', OLD.title, 'kind', OLD.kind, 'place_id', OLD.place_id, 'detail', OLD.detail, 'url', OLD.url, 'source', OLD.source, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'image_url', OLD.image_url, 'image_credit', OLD.image_credit, 'image_license', OLD.image_license, 'image_source', OLD.image_source, 'rev', OLD.rev), NULL FROM change_open;
END;

CREATE TRIGGER changes_event_notes_insert AFTER INSERT ON event_notes WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'event_notes', json_array(NEW.id), NULL, NULL, json_object('id', NEW.id, 'trip_id', NEW.trip_id, 'event_id', NEW.event_id, 'user_id', NEW.user_id, 'body', NEW.body, 'anchor_kind', NEW.anchor_kind, 'created_at', NEW.created_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_event_notes_update AFTER UPDATE ON event_notes WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'event_notes', json_array(NEW.id), NULL, json_object('id', OLD.id, 'trip_id', OLD.trip_id, 'event_id', OLD.event_id, 'user_id', OLD.user_id, 'body', OLD.body, 'anchor_kind', OLD.anchor_kind, 'created_at', OLD.created_at, 'rev', OLD.rev), json_object('id', NEW.id, 'trip_id', NEW.trip_id, 'event_id', NEW.event_id, 'user_id', NEW.user_id, 'body', NEW.body, 'anchor_kind', NEW.anchor_kind, 'created_at', NEW.created_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_event_notes_delete AFTER DELETE ON event_notes WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'event_notes', json_array(OLD.id), NULL, json_object('id', OLD.id, 'trip_id', OLD.trip_id, 'event_id', OLD.event_id, 'user_id', OLD.user_id, 'body', OLD.body, 'anchor_kind', OLD.anchor_kind, 'created_at', OLD.created_at, 'rev', OLD.rev), NULL FROM change_open;
END;

CREATE TRIGGER changes_packing_lists_insert AFTER INSERT ON packing_lists WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_lists', json_array(NEW.trip_id, NEW.key), NULL, NULL, json_object('trip_id', NEW.trip_id, 'key', NEW.key, 'name', NEW.name, 'sort', NEW.sort, 'repeat', NEW.repeat, 'dates', NEW.dates, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_lists_update AFTER UPDATE ON packing_lists WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_lists', json_array(NEW.trip_id, NEW.key), NULL, json_object('trip_id', OLD.trip_id, 'key', OLD.key, 'name', OLD.name, 'sort', OLD.sort, 'repeat', OLD.repeat, 'dates', OLD.dates, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'rev', OLD.rev), json_object('trip_id', NEW.trip_id, 'key', NEW.key, 'name', NEW.name, 'sort', NEW.sort, 'repeat', NEW.repeat, 'dates', NEW.dates, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_lists_delete AFTER DELETE ON packing_lists WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_lists', json_array(OLD.trip_id, OLD.key), NULL, json_object('trip_id', OLD.trip_id, 'key', OLD.key, 'name', OLD.name, 'sort', OLD.sort, 'repeat', OLD.repeat, 'dates', OLD.dates, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'rev', OLD.rev), NULL FROM change_open;
END;

CREATE TRIGGER changes_packing_bags_insert AFTER INSERT ON packing_bags WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_bags', json_array(NEW.trip_id, NEW.list_key, NEW.key), NULL, NULL, json_object('trip_id', NEW.trip_id, 'list_key', NEW.list_key, 'key', NEW.key, 'name', NEW.name, 'sort', NEW.sort, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_bags_update AFTER UPDATE ON packing_bags WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_bags', json_array(NEW.trip_id, NEW.list_key, NEW.key), NULL, json_object('trip_id', OLD.trip_id, 'list_key', OLD.list_key, 'key', OLD.key, 'name', OLD.name, 'sort', OLD.sort, 'rev', OLD.rev), json_object('trip_id', NEW.trip_id, 'list_key', NEW.list_key, 'key', NEW.key, 'name', NEW.name, 'sort', NEW.sort, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_bags_delete AFTER DELETE ON packing_bags WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_bags', json_array(OLD.trip_id, OLD.list_key, OLD.key), NULL, json_object('trip_id', OLD.trip_id, 'list_key', OLD.list_key, 'key', OLD.key, 'name', OLD.name, 'sort', OLD.sort, 'rev', OLD.rev), NULL FROM change_open;
END;

CREATE TRIGGER changes_packing_starters_insert AFTER INSERT ON packing_starters WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_starters', json_array(NEW.trip_id, NEW.id), NULL, NULL, json_object('trip_id', NEW.trip_id, 'id', NEW.id, 'scope', NEW.scope, 'label', NEW.label, 'category', NEW.category, 'note', NEW.note, 'qty', NEW.qty, 'bags', NEW.bags, 'sort', NEW.sort, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_starters_update AFTER UPDATE ON packing_starters WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_starters', json_array(NEW.trip_id, NEW.id), NULL, json_object('trip_id', OLD.trip_id, 'id', OLD.id, 'scope', OLD.scope, 'label', OLD.label, 'category', OLD.category, 'note', OLD.note, 'qty', OLD.qty, 'bags', OLD.bags, 'sort', OLD.sort, 'rev', OLD.rev), json_object('trip_id', NEW.trip_id, 'id', NEW.id, 'scope', NEW.scope, 'label', NEW.label, 'category', NEW.category, 'note', NEW.note, 'qty', NEW.qty, 'bags', NEW.bags, 'sort', NEW.sort, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_starters_delete AFTER DELETE ON packing_starters WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_starters', json_array(OLD.trip_id, OLD.id), NULL, json_object('trip_id', OLD.trip_id, 'id', OLD.id, 'scope', OLD.scope, 'label', OLD.label, 'category', OLD.category, 'note', OLD.note, 'qty', OLD.qty, 'bags', OLD.bags, 'sort', OLD.sort, 'rev', OLD.rev), NULL FROM change_open;
END;

CREATE TRIGGER changes_packing_items_insert AFTER INSERT ON packing_items WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_items', json_array(NEW.id), NULLIF(NEW.owner, 'group'), NULL, json_object('id', NEW.id, 'trip_id', NEW.trip_id, 'owner', NEW.owner, 'section', NEW.section, 'label', NEW.label, 'note', NEW.note, 'qty', NEW.qty, 'sort', NEW.sort, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'category', NEW.category, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_items_update AFTER UPDATE ON packing_items WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_items', json_array(NEW.id), NULLIF(NEW.owner, 'group'), json_object('id', OLD.id, 'trip_id', OLD.trip_id, 'owner', OLD.owner, 'section', OLD.section, 'label', OLD.label, 'note', OLD.note, 'qty', OLD.qty, 'sort', OLD.sort, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'category', OLD.category, 'rev', OLD.rev), json_object('id', NEW.id, 'trip_id', NEW.trip_id, 'owner', NEW.owner, 'section', NEW.section, 'label', NEW.label, 'note', NEW.note, 'qty', NEW.qty, 'sort', NEW.sort, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'category', NEW.category, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_items_delete AFTER DELETE ON packing_items WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_items', json_array(OLD.id), NULLIF(OLD.owner, 'group'), json_object('id', OLD.id, 'trip_id', OLD.trip_id, 'owner', OLD.owner, 'section', OLD.section, 'label', OLD.label, 'note', OLD.note, 'qty', OLD.qty, 'sort', OLD.sort, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'category', OLD.category, 'rev', OLD.rev), NULL FROM change_open;
END;

CREATE TRIGGER changes_packing_placements_insert AFTER INSERT ON packing_placements WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_placements', json_array(NEW.item_id, NEW.list_key), NULLIF((SELECT owner FROM packing_items WHERE id = NEW.item_id), 'group'), NULL, json_object('item_id', NEW.item_id, 'trip_id', NEW.trip_id, 'list_key', NEW.list_key, 'bag_key', NEW.bag_key, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_placements_update AFTER UPDATE ON packing_placements WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_placements', json_array(NEW.item_id, NEW.list_key), NULLIF((SELECT owner FROM packing_items WHERE id = NEW.item_id), 'group'), json_object('item_id', OLD.item_id, 'trip_id', OLD.trip_id, 'list_key', OLD.list_key, 'bag_key', OLD.bag_key, 'rev', OLD.rev), json_object('item_id', NEW.item_id, 'trip_id', NEW.trip_id, 'list_key', NEW.list_key, 'bag_key', NEW.bag_key, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_placements_delete AFTER DELETE ON packing_placements WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_placements', json_array(OLD.item_id, OLD.list_key), NULLIF((SELECT owner FROM packing_items WHERE id = OLD.item_id), 'group'), json_object('item_id', OLD.item_id, 'trip_id', OLD.trip_id, 'list_key', OLD.list_key, 'bag_key', OLD.bag_key, 'rev', OLD.rev), NULL FROM change_open;
END;

CREATE TRIGGER changes_packing_ticks_insert AFTER INSERT ON packing_ticks WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_ticks', json_array(NEW.item_id, NEW.list_key, NEW.day), NULLIF((SELECT owner FROM packing_items WHERE id = NEW.item_id), 'group'), NULL, json_object('item_id', NEW.item_id, 'trip_id', NEW.trip_id, 'list_key', NEW.list_key, 'day', NEW.day, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_ticks_update AFTER UPDATE ON packing_ticks WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_ticks', json_array(NEW.item_id, NEW.list_key, NEW.day), NULLIF((SELECT owner FROM packing_items WHERE id = NEW.item_id), 'group'), json_object('item_id', OLD.item_id, 'trip_id', OLD.trip_id, 'list_key', OLD.list_key, 'day', OLD.day, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'rev', OLD.rev), json_object('item_id', NEW.item_id, 'trip_id', NEW.trip_id, 'list_key', NEW.list_key, 'day', NEW.day, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_packing_ticks_delete AFTER DELETE ON packing_ticks WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'packing_ticks', json_array(OLD.item_id, OLD.list_key, OLD.day), NULLIF((SELECT owner FROM packing_items WHERE id = OLD.item_id), 'group'), json_object('item_id', OLD.item_id, 'trip_id', OLD.trip_id, 'list_key', OLD.list_key, 'day', OLD.day, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'rev', OLD.rev), NULL FROM change_open;
END;

CREATE TRIGGER changes_purchases_insert AFTER INSERT ON purchases WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'purchases', json_array(NEW.id), NULL, NULL, json_object('id', NEW.id, 'trip_id', NEW.trip_id, 'description', NEW.description, 'amount_minor', NEW.amount_minor, 'currency', NEW.currency, 'amount_exp', NEW.amount_exp, 'paid_by', NEW.paid_by, 'split_mode', NEW.split_mode, 'spent_at', NEW.spent_at, 'day', NEW.day, 'event_id', NEW.event_id, 'place_id', NEW.place_id, 'note', NEW.note, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'rev', NEW.rev, 'kind', NEW.kind) FROM change_open;
END;

CREATE TRIGGER changes_purchases_update AFTER UPDATE ON purchases WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'purchases', json_array(NEW.id), NULL, json_object('id', OLD.id, 'trip_id', OLD.trip_id, 'description', OLD.description, 'amount_minor', OLD.amount_minor, 'currency', OLD.currency, 'amount_exp', OLD.amount_exp, 'paid_by', OLD.paid_by, 'split_mode', OLD.split_mode, 'spent_at', OLD.spent_at, 'day', OLD.day, 'event_id', OLD.event_id, 'place_id', OLD.place_id, 'note', OLD.note, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'rev', OLD.rev, 'kind', OLD.kind), json_object('id', NEW.id, 'trip_id', NEW.trip_id, 'description', NEW.description, 'amount_minor', NEW.amount_minor, 'currency', NEW.currency, 'amount_exp', NEW.amount_exp, 'paid_by', NEW.paid_by, 'split_mode', NEW.split_mode, 'spent_at', NEW.spent_at, 'day', NEW.day, 'event_id', NEW.event_id, 'place_id', NEW.place_id, 'note', NEW.note, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'rev', NEW.rev, 'kind', NEW.kind) FROM change_open;
END;

CREATE TRIGGER changes_purchases_delete AFTER DELETE ON purchases WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'purchases', json_array(OLD.id), NULL, json_object('id', OLD.id, 'trip_id', OLD.trip_id, 'description', OLD.description, 'amount_minor', OLD.amount_minor, 'currency', OLD.currency, 'amount_exp', OLD.amount_exp, 'paid_by', OLD.paid_by, 'split_mode', OLD.split_mode, 'spent_at', OLD.spent_at, 'day', OLD.day, 'event_id', OLD.event_id, 'place_id', OLD.place_id, 'note', OLD.note, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'rev', OLD.rev, 'kind', OLD.kind), NULL FROM change_open;
END;

CREATE TRIGGER changes_purchase_shares_insert AFTER INSERT ON purchase_shares WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'purchase_shares', json_array(NEW.purchase_id, NEW.user_id), NULL, NULL, json_object('purchase_id', NEW.purchase_id, 'user_id', NEW.user_id, 'weight', NEW.weight, 'share_minor', NEW.share_minor) FROM change_open;
END;

CREATE TRIGGER changes_purchase_shares_update AFTER UPDATE ON purchase_shares WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'purchase_shares', json_array(NEW.purchase_id, NEW.user_id), NULL, json_object('purchase_id', OLD.purchase_id, 'user_id', OLD.user_id, 'weight', OLD.weight, 'share_minor', OLD.share_minor), json_object('purchase_id', NEW.purchase_id, 'user_id', NEW.user_id, 'weight', NEW.weight, 'share_minor', NEW.share_minor) FROM change_open;
END;

CREATE TRIGGER changes_purchase_shares_delete AFTER DELETE ON purchase_shares WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'purchase_shares', json_array(OLD.purchase_id, OLD.user_id), NULL, json_object('purchase_id', OLD.purchase_id, 'user_id', OLD.user_id, 'weight', OLD.weight, 'share_minor', OLD.share_minor), NULL FROM change_open;
END;

CREATE TRIGGER changes_pictures_insert AFTER INSERT ON pictures WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'pictures', json_array(NEW.trip_id, NEW.target_kind, NEW.target_id), NULL, NULL, json_object('trip_id', NEW.trip_id, 'target_kind', NEW.target_kind, 'target_id', NEW.target_id, 'role', NEW.role, 'r2_key', NEW.r2_key, 'mime', NEW.mime, 'width', NEW.width, 'height', NEW.height, 'bytes', NEW.bytes, 'license', NEW.license, 'credit', NEW.credit, 'source', NEW.source, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_pictures_update AFTER UPDATE ON pictures WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'pictures', json_array(NEW.trip_id, NEW.target_kind, NEW.target_id), NULL, json_object('trip_id', OLD.trip_id, 'target_kind', OLD.target_kind, 'target_id', OLD.target_id, 'role', OLD.role, 'r2_key', OLD.r2_key, 'mime', OLD.mime, 'width', OLD.width, 'height', OLD.height, 'bytes', OLD.bytes, 'license', OLD.license, 'credit', OLD.credit, 'source', OLD.source, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'rev', OLD.rev), json_object('trip_id', NEW.trip_id, 'target_kind', NEW.target_kind, 'target_id', NEW.target_id, 'role', NEW.role, 'r2_key', NEW.r2_key, 'mime', NEW.mime, 'width', NEW.width, 'height', NEW.height, 'bytes', NEW.bytes, 'license', NEW.license, 'credit', NEW.credit, 'source', NEW.source, 'created_by', NEW.created_by, 'created_at', NEW.created_at, 'rev', NEW.rev) FROM change_open;
END;

CREATE TRIGGER changes_pictures_delete AFTER DELETE ON pictures WHEN EXISTS (SELECT 1 FROM change_open)
BEGIN
  INSERT INTO trip_change_rows (change_id, tbl, row_key, private_to, before, after)
  SELECT change_id, 'pictures', json_array(OLD.trip_id, OLD.target_kind, OLD.target_id), NULL, json_object('trip_id', OLD.trip_id, 'target_kind', OLD.target_kind, 'target_id', OLD.target_id, 'role', OLD.role, 'r2_key', OLD.r2_key, 'mime', OLD.mime, 'width', OLD.width, 'height', OLD.height, 'bytes', OLD.bytes, 'license', OLD.license, 'credit', OLD.credit, 'source', OLD.source, 'created_by', OLD.created_by, 'created_at', OLD.created_at, 'rev', OLD.rev), NULL FROM change_open;
END;
