-- 0036: "since my last". A phone that holds the trip as of rev N asks for what changed after N
-- (GET /api/trips/<id>?since=N, src/api/trip.js) instead of the whole trip. Rows that changed say so by
-- their own rev; rows that went leave nothing, so this records them:
--
--   trip_gone          one line for each row deleted from a table the trip's snapshot sends, written by a
--                      trigger on that table (so every route that deletes is covered, and undo's too), with the
--                      trip's rev at the delete (a write moves the rev first, in the same batch: rev.js) and, for
--                      someone's own packing item, whose it was (only their phone hears of it).
--   trip_delta_floor   per trip, the rev below which this record isn't kept: since=N under it answers the whole
--                      trip. Set here to each trip's rev now (what was deleted before today was never recorded);
--                      a trip made after this has none (0: everything recorded). The drain trims old lines and
--                      moves the floor up (src/trips/drain.js).
--
-- And an index on (trip_id, rev) for each table read by rev. Tables and indexes only, and triggers that write
-- only trip_gone: an old Worker reads past all of it, so it may go before the deploy.

CREATE TABLE trip_gone (
  trip_id TEXT NOT NULL,
  tbl TEXT NOT NULL,
  row_key TEXT NOT NULL,
  private_to TEXT,
  rev INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX trip_gone_by_rev ON trip_gone (trip_id, rev);
CREATE INDEX trip_gone_by_at ON trip_gone (at);

CREATE TABLE trip_delta_floor (
  trip_id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL
);
INSERT INTO trip_delta_floor (trip_id, rev) SELECT id, rev FROM trips;

CREATE TRIGGER gone_areas AFTER DELETE ON areas BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'areas', OLD.id, NULL, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER gone_places AFTER DELETE ON places BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'places', OLD.id, NULL, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER gone_events AFTER DELETE ON events BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'events', OLD.id, NULL, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER gone_purchases AFTER DELETE ON purchases BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'purchases', OLD.id, NULL, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER gone_packing_items AFTER DELETE ON packing_items BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'packing_items', OLD.id,
    CASE WHEN OLD.owner = 'group' THEN NULL ELSE OLD.owner END, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER gone_packing_lists AFTER DELETE ON packing_lists BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'packing_lists', OLD.key, NULL, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER gone_packing_bags AFTER DELETE ON packing_bags BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'packing_bags', OLD.list_key || '/' || OLD.key, NULL, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER gone_packing_placements AFTER DELETE ON packing_placements BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'packing_placements', OLD.item_id || '/' || OLD.list_key, NULL, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER gone_packing_ticks AFTER DELETE ON packing_ticks BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'packing_ticks', OLD.item_id || '/' || OLD.list_key || '/' || COALESCE(OLD.day, ''), NULL, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER gone_packing_starters AFTER DELETE ON packing_starters BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'packing_starters', OLD.id, NULL, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;
CREATE TRIGGER gone_pictures AFTER DELETE ON pictures BEGIN
  INSERT INTO trip_gone (trip_id, tbl, row_key, private_to, rev, at) VALUES (OLD.trip_id, 'pictures', OLD.target_kind || '/' || OLD.target_id, NULL, COALESCE((SELECT rev FROM trips WHERE id = OLD.trip_id), 0), CAST(strftime('%s', 'now') AS INTEGER));
END;

CREATE INDEX areas_by_rev ON areas (trip_id, rev);
CREATE INDEX places_by_rev ON places (trip_id, rev);
CREATE INDEX events_by_rev ON events (trip_id, rev);
CREATE INDEX purchases_by_rev ON purchases (trip_id, rev);
CREATE INDEX packing_items_by_rev ON packing_items (trip_id, rev);
CREATE INDEX packing_lists_by_rev ON packing_lists (trip_id, rev);
CREATE INDEX packing_bags_by_rev ON packing_bags (trip_id, rev);
CREATE INDEX packing_placements_by_rev ON packing_placements (trip_id, rev);
CREATE INDEX packing_ticks_by_rev ON packing_ticks (trip_id, rev);
CREATE INDEX packing_starters_by_rev ON packing_starters (trip_id, rev);
CREATE INDEX pictures_by_rev ON pictures (trip_id, rev);
CREATE INDEX messages_by_rev ON messages (trip_id, rev);
-- How often each currency is paid in (the snapshot's currencies, every delta too), from the index alone.
CREATE INDEX purchases_by_currency ON purchases (trip_id, currency);
