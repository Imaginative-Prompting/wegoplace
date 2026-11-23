-- Trips, each with its own people.
--
-- Until this file the site held one trip and everyone on it. Now any account can make a trip,
-- people join one by a link, and every route names the trip it is about (src/trips/).
--
--   * A trip has a host: the account its storage counts against, and the only one who can
--     remove people, hand the trip over or revoke a link. `trips.host_id` is the one place
--     that says who; `trip_members.role` said 'owner' or 'member' and is dropped.
--   * `users.is_admin` is dropped. It marked the site's first account, which alone could bring
--     a trip in. Nothing is site-wide any more: what it could do, a trip's host can do in
--     that trip.
--   * A trip that is already here gets its host: the member whose role was 'owner'; failing
--     that the account that had `is_admin`, which is put on the trip if it wasn't; failing
--     that the member who joined first. An account that has been deleted is never chosen
--     while another can be.
--   * `rev`: a trip's goes up by one in every write to anything in it, and each row keeps the
--     trip's rev as of its own last write (src/trips/rev.js). A client asks for the trip's
--     rev to learn whether anything changed.
--   * `left_at`: someone who left, or was removed, keeps their row. What they wrote and paid
--     stays under their name; they stop seeing the trip.
--   * `trip_links`: the links people join by. Only a hash of the code is kept.
--   * A place with no trip belonged to "the trip", when there was one. It is given to the
--     trip that exists, if exactly one does; otherwise it stays where no route reads it.
--   * `purchases.kind`: 'purchase', or 'payment' (one person gave another money to settle up).
--   * A trip's dates may not be known yet. The columns stay NOT NULL: '' is "not known", and
--     the routes give null.
--   * A trip's board has its seed from the day the trip is made. It used to be given on the
--     first read; a trip that was never read gets one here.
--
-- Run it as one file, once (`ALTER TABLE … ADD COLUMN` can't be run twice).

ALTER TABLE trips ADD COLUMN host_id TEXT REFERENCES users(id);
ALTER TABLE trips ADD COLUMN updated_at INTEGER;
ALTER TABLE trips ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
UPDATE trips SET updated_at = created_at;

ALTER TABLE trip_members ADD COLUMN left_at INTEGER;
ALTER TABLE trip_members ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;

-- The account that ran the site joins each trip that has no owner of its own, so it can host it.
INSERT OR IGNORE INTO trip_members (trip_id, user_id, role, joined_at)
  SELECT t.id, a.id, 'member', t.created_at
  FROM trips t
  JOIN (SELECT id FROM users WHERE is_admin = 1 AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1) a
  WHERE NOT EXISTS (
    SELECT 1 FROM trip_members m JOIN users u ON u.id = m.user_id
    WHERE m.trip_id = t.id AND m.role = 'owner' AND u.deleted_at IS NULL);

UPDATE trips SET host_id = COALESCE(
  (SELECT m.user_id FROM trip_members m JOIN users u ON u.id = m.user_id
    WHERE m.trip_id = trips.id AND m.role = 'owner' AND u.deleted_at IS NULL
    ORDER BY m.joined_at, m.user_id LIMIT 1),
  (SELECT m.user_id FROM trip_members m JOIN users u ON u.id = m.user_id
    WHERE m.trip_id = trips.id AND u.is_admin = 1 AND u.deleted_at IS NULL
    ORDER BY u.created_at, u.id LIMIT 1),
  (SELECT m.user_id FROM trip_members m JOIN users u ON u.id = m.user_id
    WHERE m.trip_id = trips.id AND u.deleted_at IS NULL
    ORDER BY m.joined_at, m.user_id LIMIT 1),
  (SELECT m.user_id FROM trip_members m WHERE m.trip_id = trips.id ORDER BY m.joined_at, m.user_id LIMIT 1));

ALTER TABLE trip_members DROP COLUMN role;
ALTER TABLE users DROP COLUMN is_admin;

UPDATE trips SET collage_seed = lower(hex(randomblob(8))), collage_version = 1 WHERE collage_seed IS NULL;

-- Which trips an account is on: the list behind its home screen, read on every sign-in.
CREATE INDEX trip_members_user ON trip_members(user_id);

CREATE TABLE trip_links (
  id TEXT PRIMARY KEY,              -- what a link is called when it is listed or revoked; not the code
  trip_id TEXT NOT NULL REFERENCES trips(id),
  code_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of the code in the link; the code itself is shown once, to its maker
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,  -- people it has put on the trip; someone already on it costs none
  revoked_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX trip_links_trip ON trip_links(trip_id, created_at);

UPDATE places SET trip_id = (SELECT id FROM trips LIMIT 1)
  WHERE trip_id IS NULL AND (SELECT COUNT(*) FROM trips) = 1;

ALTER TABLE places ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_notes ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE packing_items ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE packing_views ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE packing_sections ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE packing_placements ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collage_shares ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;

ALTER TABLE purchases ADD COLUMN kind TEXT NOT NULL DEFAULT 'purchase' CHECK (kind IN ('purchase', 'payment'));
