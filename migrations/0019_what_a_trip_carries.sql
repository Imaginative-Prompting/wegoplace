-- 0019: what a trip carries.
--
--   * Areas: the named parts of a trip, a region with bounds and its neighborhoods under it.
--     A place points at an area by id.
--   * `trips.interests`: what the group cares about, in their words.
--   * `users.units`: 'metric' or 'imperial'; NULL until the person picks, so the app goes by
--     the phone's locale until then.
--   * Ids that are unique within a trip, not across the site (a place, an event, an area): the
--     key of `places` and `events` becomes (trip_id, id). Two trips may both have a place
--     called "stay-lisbon"; one trip can't have two.
--   * Events lose `scenario` (the Hike tab's data, gone with it) and gain `source`, where a
--     row came from when it wasn't typed in the app (an import, an AI's change).
--   * A place may have no coordinates yet ("not confirmed"), and no address: both columns
--     take NULL now. 0,0 is refused by the routes.
--   * Packing lists belong to the trip. Until now each person had their own copy of each list
--     (`packing_views`) with its own bags (`packing_sections`). Now the trip has its lists
--     (`packing_lists`, each packed once or for the day) and each list its bags
--     (`packing_bags`); an item, still a person's or the group's, has at most one bag on each
--     list (`packing_placements`), and its ticks are per list (`packing_ticks`): ticking the
--     rain jacket for one list doesn't tick it for another. `packing_starters` are the trip's
--     suggested items.
--
-- HOW TODAY'S LISTS BECOME THE TRIP'S. Within a trip, every person's list of the same name is
-- one list; its bags are the bags any of those copies had, by name (a bag one person added
-- joins the list, empty for everyone else). A list's and a bag's key is its name in small
-- letters with spaces as hyphens ("Leaving home" is `leaving-home`), and its place in the
-- order is the earliest any copy had. Every placement keeps its bag. An item that was ticked
-- is ticked on every list it has a bag on: it showed ticked on all of them, so nothing looks
-- different. A trip that comes out with no list at all gets the one a new trip starts with,
-- "Leaving home" (Main bag, Day bag, On me): the app never shows a trip with none.
--
-- An event that points at a place with no trip stops this file, loudly, on the foreign key at
-- its end: that place isn't copied (above). It can't happen where the database holds one trip
-- (0017 gave its places to it).
--
-- WHY FOUR TABLES ARE MADE AGAIN. SQLite can't change a table's key, so `places` and `events`
-- are rebuilt. What points at them changes with them:
--   * `event_notes` gains `trip_id`, so a note points at (trip, event).
--   * `purchases` keeps `event_id` and `place_id` but without a foreign key. It had one with
--     ON DELETE SET NULL (a purchase whose event goes away floats, and keeps its money). On a
--     two-part key, SET NULL would empty `trip_id` as well, so the routes that delete an event
--     or a place clear the purchases' pointer in the same batch instead (src/api/events.js,
--     src/api/places.js).
-- Nothing here relies on their checks waiting until the end of the file. The pragma below asks
-- for that, but a remote D1 running this file (`wrangler d1 execute --remote --file`) checks
-- each statement at once: no table is dropped while a row elsewhere still points at it.
-- `purchase_shares`, which points at `purchases`, is set aside and dropped first, and made again
-- after. Every other table is dropped after the tables that point at it (checks/migrations/
-- immediate.mjs runs every migration so). Nothing is renamed: each table is copied aside,
-- dropped, made again under its own name and filled, as 0016 did with `users`.
--
-- A place with no trip was left where no route reads it by 0017 (it happened only where a
-- database held several trips, or none). It has no key in this table and isn't copied.
--
-- Run it as one file, once.

PRAGMA defer_foreign_keys = true;

-- Left behind only if this file was once run outside a transaction.
DROP TABLE IF EXISTS places_moving;
DROP TABLE IF EXISTS events_moving;
DROP TABLE IF EXISTS event_notes_moving;
DROP TABLE IF EXISTS purchases_moving;
DROP TABLE IF EXISTS packing_moving;

CREATE TABLE places_moving AS SELECT * FROM places WHERE trip_id IS NOT NULL;
CREATE TABLE events_moving AS SELECT * FROM events;
CREATE TABLE event_notes_moving AS
  SELECT n.*, e.trip_id AS note_trip FROM event_notes n JOIN events e ON e.id = n.event_id;
CREATE TABLE purchases_moving AS SELECT * FROM purchases;
-- Each old placement with the keys its list and bag will have.
CREATE TABLE packing_moving AS
  SELECT p.item_id, v.trip_id, lower(replace(trim(v.name), ' ', '-')) AS list_key,
    lower(replace(trim(s.name), ' ', '-')) AS bag_key, p.rev
  FROM packing_placements p JOIN packing_views v ON v.id = p.view_id JOIN packing_sections s ON s.id = p.section_id;

DROP INDEX IF EXISTS idx_notes_event;
DROP INDEX IF EXISTS idx_events_trip_start;
DROP INDEX IF EXISTS idx_events_scenario;
DROP INDEX IF EXISTS idx_places_trip;
DROP INDEX IF EXISTS idx_places_area;
DROP INDEX IF EXISTS idx_purchases_trip;
-- purchase_shares points at purchases: it is set aside and dropped first, so no row points at purchases when it is
-- dropped. Without this, dropping purchases depends on defer_foreign_keys being in force, and a remote D1 refused it.
DROP TABLE IF EXISTS purchase_shares_moving;
CREATE TABLE purchase_shares_moving AS SELECT * FROM purchase_shares;
DROP TABLE purchase_shares;
DROP TABLE event_notes;
DROP TABLE purchases;
DROP TABLE events;
DROP TABLE places;

-- ── areas ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE areas (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent TEXT,                      -- a top-level area of the same trip; NULL for a top-level one
  west REAL, south REAL, east REAL, north REAL,   -- all four or none
  sort INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, id),
  FOREIGN KEY (trip_id, parent) REFERENCES areas(trip_id, id)
);

-- ── places ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE places (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_local TEXT DEFAULT '',
  kind TEXT NOT NULL,               -- why they'd go: public/js/shared/place-kinds.js PLACE_KINDS
  subkind TEXT NOT NULL,            -- what it is: the same module's list
  area TEXT,                        -- an area of the same trip, by id (until older area codes are area rows, not a foreign key)
  address TEXT DEFAULT '',          -- as written locally; readable aloud to a taxi driver
  address_note TEXT DEFAULT '',
  lat REAL,                         -- NULL, with lng, while nobody has confirmed where it is
  lng REAL,
  gmaps_place_id TEXT DEFAULT '',
  rating REAL DEFAULT 0,            -- 0 with rating_count 0: none
  rating_count INTEGER DEFAULT 0,
  price_level INTEGER DEFAULT 0,    -- 1 to 4; 0: not known
  hours TEXT DEFAULT '',            -- the one format (public/js/shared/hours.js)
  phone TEXT DEFAULT '',
  website TEXT DEFAULT '',
  why TEXT NOT NULL,
  notes TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',           -- JSON array
  near_anchor TEXT DEFAULT '',      -- a place of the same trip, by id
  walk_minutes INTEGER DEFAULT 0,
  confidence TEXT DEFAULT 'medium',
  source TEXT DEFAULT '',
  is_anchor INTEGER DEFAULT 0,
  verified_at INTEGER,
  image_url TEXT DEFAULT '',
  image_credit TEXT DEFAULT '',
  image_license TEXT DEFAULT '',
  image_source TEXT DEFAULT '',
  elevation_m INTEGER DEFAULT 0,
  checkout TEXT DEFAULT '',
  created_by TEXT,                  -- NULL for rows from before this file
  updated_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, id)
);

INSERT INTO places (trip_id, id, name, name_local, kind, subkind, area, address, address_note, lat, lng,
    gmaps_place_id, rating, rating_count, price_level, hours, phone, website, why, notes, tags, near_anchor,
    walk_minutes, confidence, source, is_anchor, verified_at, image_url, image_credit, image_license,
    image_source, elevation_m, checkout, rev)
  SELECT trip_id, id, name, name_local, kind, subkind, area, address, address_note, lat, lng,
    gmaps_place_id, rating, rating_count, price_level, hours, phone, website, why, notes, tags, near_anchor,
    walk_minutes, confidence, source, is_anchor, verified_at, image_url, image_credit, image_license,
    image_source, elevation_m, checkout, rev
  FROM places_moving;

-- ── events ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE events (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,       -- epoch UTC
  ends_at INTEGER,                  -- epoch UTC; NULL = a point in time
  tz TEXT NOT NULL,                 -- IANA zone the start is shown in
  end_tz TEXT,                      -- the end's, when it differs (a flight)
  all_day INTEGER DEFAULT 0,
  title TEXT NOT NULL,
  kind TEXT DEFAULT 'plan',         -- flight|meal|lodging|activity|transit|plan
  place_id TEXT,                    -- a place of the same trip
  detail TEXT DEFAULT '',
  url TEXT DEFAULT '',
  source TEXT DEFAULT '',           -- where the row came from, when it wasn't typed in the app
  created_by TEXT NOT NULL,         -- an account; 'seed' only on rows imported before this file
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  image_url TEXT DEFAULT '',
  image_credit TEXT DEFAULT '',
  image_license TEXT DEFAULT '',
  image_source TEXT DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, id),
  FOREIGN KEY (trip_id, place_id) REFERENCES places(trip_id, id)
);

INSERT INTO events (trip_id, id, starts_at, ends_at, tz, end_tz, all_day, title, kind, place_id, detail, url,
    source, created_by, created_at, updated_at, image_url, image_credit, image_license, image_source, rev)
  SELECT trip_id, id, starts_at, ends_at, tz, end_tz, all_day, title, kind, place_id, detail, url,
    CASE WHEN created_by = 'seed' THEN 'import' ELSE '' END, created_by, created_at, updated_at,
    image_url, image_credit, image_license, image_source, rev
  FROM events_moving;

-- ── notes on events ────────────────────────────────────────────────────────────────────────
CREATE TABLE event_notes (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  anchor_kind TEXT DEFAULT 'event',
  created_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (trip_id, event_id) REFERENCES events(trip_id, id)
);

INSERT INTO event_notes (id, trip_id, event_id, user_id, body, anchor_kind, created_at, rev)
  SELECT id, note_trip, event_id, user_id, body, anchor_kind, created_at, rev FROM event_notes_moving;

-- ── purchases ──────────────────────────────────────────────────────────────────────────────
-- As 0011 made it, with 0017's columns, and `event_id` / `place_id` without a foreign key
-- (above). The column notes that matter are 0011's.
CREATE TABLE purchases (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  description TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  amount_exp INTEGER NOT NULL DEFAULT 2,
  paid_by TEXT NOT NULL REFERENCES users(id),
  split_mode TEXT NOT NULL DEFAULT 'weight',
  spent_at INTEGER NOT NULL,
  day TEXT DEFAULT '',
  event_id TEXT,                    -- an event of the same trip; cleared when it is deleted
  place_id TEXT,                    -- a place of the same trip; cleared when it is deleted
  note TEXT DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'purchase' CHECK (kind IN ('purchase', 'payment'))
);

INSERT INTO purchases (id, trip_id, description, amount_minor, currency, amount_exp, paid_by, split_mode,
    spent_at, day, event_id, place_id, note, created_by, created_at, updated_at, rev, kind)
  SELECT id, trip_id, description, amount_minor, currency, amount_exp, paid_by, split_mode,
    spent_at, day, event_id, place_id, note, created_by, created_at, updated_at, rev, kind
  FROM purchases_moving;

CREATE TABLE purchase_shares (
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  user_id TEXT NOT NULL REFERENCES users(id),

  -- WHAT THE PERSON AGREED TO. Under split_mode='weight' it is relative (all 1s = even, 2 =
  -- "counts double"); under 'exact' it IS the minor-unit amount they owe and the set must sum
  -- to amount_minor. Both are integers for the same reason the amount is.
  weight INTEGER NOT NULL,

  -- WHAT THE PERSON OWES, resolved. Always integer minor units of the purchase's currency,
  -- and SUM(share_minor) = purchases.amount_minor is enforced by functions/api/purchases.js
  -- on every write. This column is derivable from (amount_minor, weight) — it is stored
  -- anyway, for the same reason media_usage stores a total it could SUM(): it is what the
  -- settle-up reads on every render, and it is the one place the invariant is materialised
  -- where a query can check it.
  share_minor INTEGER NOT NULL,

  PRIMARY KEY (purchase_id, user_id)
);
INSERT INTO purchase_shares (purchase_id, user_id, weight, share_minor)
  SELECT purchase_id, user_id, weight, share_minor FROM purchase_shares_moving;
DROP TABLE purchase_shares_moving;

DROP TABLE places_moving;
DROP TABLE events_moving;
DROP TABLE event_notes_moving;
DROP TABLE purchases_moving;

CREATE INDEX idx_areas_parent ON areas(trip_id, parent);
CREATE INDEX idx_places_area ON places(trip_id, area);
CREATE INDEX idx_events_trip_start ON events(trip_id, starts_at);
CREATE INDEX idx_events_place ON events(trip_id, place_id);
CREATE INDEX idx_notes_event ON event_notes(trip_id, event_id);
CREATE INDEX idx_purchases_trip ON purchases(trip_id, spent_at, id);

-- ── packing ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE packing_lists (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  repeat TEXT NOT NULL DEFAULT 'once' CHECK (repeat IN ('once', 'daily')),
  dates TEXT,                       -- a daily list for named days only: a JSON array of YYYY-MM-DD; NULL is every day
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, key)
);

CREATE TABLE packing_bags (
  trip_id TEXT NOT NULL,
  list_key TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, list_key, key),
  FOREIGN KEY (trip_id, list_key) REFERENCES packing_lists(trip_id, key)
);

INSERT INTO packing_lists (trip_id, key, name, sort, repeat, created_at, updated_at, rev)
  SELECT v.trip_id, k.key,
    (SELECT v2.name FROM packing_views v2 WHERE v2.trip_id = v.trip_id AND lower(replace(trim(v2.name), ' ', '-')) = k.key
      ORDER BY v2.sort, v2.id LIMIT 1),
    MIN(COALESCE(v.sort, 0)), 'once', COALESCE(t.created_at, 0), COALESCE(t.created_at, 0), MAX(v.rev)
  FROM packing_views v
  JOIN (SELECT id, lower(replace(trim(name), ' ', '-')) AS key FROM packing_views) k ON k.id = v.id
  JOIN trips t ON t.id = v.trip_id
  GROUP BY v.trip_id, k.key;

INSERT INTO packing_bags (trip_id, list_key, key, name, sort, rev)
  SELECT v.trip_id, lower(replace(trim(v.name), ' ', '-')), lower(replace(trim(s.name), ' ', '-')),
    MIN(s.name), MIN(COALESCE(s.sort, 0)), MAX(s.rev)
  FROM packing_sections s JOIN packing_views v ON v.id = s.view_id
  GROUP BY v.trip_id, lower(replace(trim(v.name), ' ', '-')), lower(replace(trim(s.name), ' ', '-'));

DROP INDEX IF EXISTS idx_packing_views_owner;
DROP INDEX IF EXISTS idx_packing_sections_view;
DROP INDEX IF EXISTS idx_packing_placements_section;
DROP TABLE packing_placements;
DROP TABLE packing_sections;
DROP TABLE packing_views;

CREATE TABLE packing_placements (
  item_id TEXT NOT NULL REFERENCES packing_items(id),
  trip_id TEXT NOT NULL,
  list_key TEXT NOT NULL,
  bag_key TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, list_key),
  FOREIGN KEY (trip_id, list_key, bag_key) REFERENCES packing_bags(trip_id, list_key, key)
);

-- What can collide: one item with a bag in two people's copies of the same-named list (a group
-- item someone took over, then handed back). It keeps one bag there; the placement count staying
-- equal on a real export is what shows nothing was dropped.
INSERT OR IGNORE INTO packing_placements (item_id, trip_id, list_key, bag_key, rev)
  SELECT item_id, trip_id, list_key, bag_key, rev FROM packing_moving;

-- A tick on a list. A packed-once list's tick has no day ('');
-- a daily list's carries the trip's day it was ticked for.
CREATE TABLE packing_ticks (
  item_id TEXT NOT NULL REFERENCES packing_items(id),
  trip_id TEXT NOT NULL,
  list_key TEXT NOT NULL,
  day TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, list_key, day),
  FOREIGN KEY (trip_id, list_key) REFERENCES packing_lists(trip_id, key)
);

INSERT INTO packing_ticks (item_id, trip_id, list_key, day, created_by, created_at, rev)
  SELECT p.item_id, p.trip_id, p.list_key, '', NULL, i.updated_at, i.rev
  FROM packing_placements p JOIN packing_items i ON i.id = p.item_id
  WHERE i.done = 1;

ALTER TABLE packing_items DROP COLUMN done;

-- A trip with no list gets the first one (src/api/packing/lists.js, FIRST_LIST).
INSERT INTO packing_lists (trip_id, key, name, sort, repeat, created_at, updated_at, rev)
  SELECT t.id, 'leaving-home', 'Leaving home', 0, 'once', t.created_at, t.created_at, t.rev FROM trips t
  WHERE NOT EXISTS (SELECT 1 FROM packing_lists l WHERE l.trip_id = t.id);
INSERT INTO packing_bags (trip_id, list_key, key, name, sort, rev)
  SELECT l.trip_id, 'leaving-home', b.key, b.name, b.sort, l.rev
  FROM packing_lists l JOIN (SELECT 'main-bag' AS key, 'Main bag' AS name, 0 AS sort
    UNION ALL SELECT 'day-bag', 'Day bag', 1 UNION ALL SELECT 'on-me', 'On me', 2) b
  WHERE l.key = 'leaving-home' AND NOT EXISTS (SELECT 1 FROM packing_bags x WHERE x.trip_id = l.trip_id AND x.list_key = 'leaving-home');

CREATE TABLE packing_starters (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('person', 'group')),
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  qty INTEGER,
  bags TEXT NOT NULL DEFAULT '{}',  -- JSON: { list key: bag key }; a list left out isn't carried on
  sort INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, id)
);

DROP TABLE packing_moving;

CREATE INDEX idx_packing_bags_list ON packing_bags(trip_id, list_key, sort);
CREATE INDEX idx_packing_placements_bag ON packing_placements(trip_id, list_key, bag_key);
CREATE INDEX idx_packing_ticks_list ON packing_ticks(trip_id, list_key, day);

-- ── the trip, and the person ───────────────────────────────────────────────────────────────
ALTER TABLE trips ADD COLUMN interests TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN units TEXT CHECK (units IN ('metric', 'imperial'));
