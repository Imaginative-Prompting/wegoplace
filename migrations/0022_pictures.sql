-- Pictures (model §6, §17): one stored image per place, event, the trip's cover, and a
-- purchase's receipt. The file is a media_objects row like every file in the bucket (role
-- 'picture' or 'receipt'), so the host's storage counts it through the same rows; this table
-- says what it hangs on, and its license, credit and source.
--
-- One picture per thing: the key is the thing. A picture replaced or removed by hand goes from
-- the bucket (the drain); one a change replaced (the MCP, model §9) keeps its media_objects row,
-- stored and counted, named by the change, with no row here pointing at it.
--
-- And the one-use links an AI with a shell uploads a picture to: only the token's hash is kept,
-- like a join link's.
--
-- Applied as ONE file after 0021.
CREATE TABLE pictures (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('place', 'event', 'cover', 'purchase')),
  target_id TEXT NOT NULL,                                 -- '' for the cover (the trip itself)
  role TEXT NOT NULL CHECK (role IN ('picture', 'receipt')),
  r2_key TEXT NOT NULL UNIQUE REFERENCES media_objects(r2_key),
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  license TEXT NOT NULL,
  credit TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (trip_id, target_kind, target_id),
  CHECK ((target_kind = 'purchase') = (role = 'receipt')),
  CHECK ((target_kind = 'cover') = (target_id = ''))
);

CREATE TABLE picture_links (
  token_hash TEXT PRIMARY KEY,                             -- SHA-256 of the token; the token itself is never kept
  trip_id TEXT NOT NULL REFERENCES trips(id),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('place', 'event', 'cover', 'purchase')),
  target_id TEXT NOT NULL,
  license TEXT NOT NULL,
  credit TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX idx_picture_links_trip ON picture_links(trip_id);
