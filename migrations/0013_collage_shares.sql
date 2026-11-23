-- 0013: shared collages — the public snapshot behind wegoplace.com/s/<id>.
--
-- A shareable link shows people a trip's photos collaged up, hosted at wegoplace.com/s/<id>, with
-- a way for whoever sees it to make a trip of their own.
--
-- A SHARE IS A SNAPSHOT, NOT A LIVE VIEW, and that was decided rather than assumed — a share
-- outlives the trip's storage window, so it cannot be a query that re-runs against media which
-- may be gone. What is stored is the RENDERED PICTURE: one R2 object, flat, finished, and
-- readable by a stranger with no session and no idea what a trip is.
--
-- IT ALSO CANNOT LEAK THE TRIP. The row points at an image and carries a title; it does not
-- carry the memories, the captions, the tags, the members or the itinerary. Somebody who
-- guesses an id gets a picture of a corkboard, which is exactly what was deliberately shared.
--
-- THE ID IS THE SECRET. There is no other gate — that is what a share link is — so it is minted
-- with 128 bits of randomness in functions/api/collage.js and is not derived from the trip id,
-- the user id or the time. Guessing one is not a threat model anybody has to think about again.
CREATE TABLE IF NOT EXISTS collage_shares (
  id TEXT PRIMARY KEY,                   -- url-safe, 128 bits of crypto randomness
  trip_id TEXT NOT NULL REFERENCES trips(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,

  title TEXT DEFAULT '',                 -- what the page and the link preview say
  image_key TEXT NOT NULL,               -- the R2 object: the rendered board, flat
  image_mime TEXT NOT NULL DEFAULT 'image/jpeg',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,

  -- A looping render, when one was made. Optional: the still is the funnel's job and the video
  -- is a bonus, and a share must never fail because a phone could not record.
  video_key TEXT DEFAULT '',
  video_mime TEXT DEFAULT '',
  video_bytes INTEGER NOT NULL DEFAULT 0,

  -- Revocation without deletion: the row and the bytes stay, the page stops answering. Somebody
  -- who shared a board with the wrong person wants it dead NOW, not after a cleanup job.
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_shares_trip ON collage_shares(trip_id, created_at DESC);
