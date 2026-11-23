-- 0014: the individual photographs behind a shared board.
--
-- WHY. A flattened board is one JPEG, and one JPEG has a ceiling: iOS Safari refuses a canvas
-- over 4096x4096, so twenty prints share about 800px each, and they look poor as soon as
-- someone zooms in. A shared link should show the photos and videos at or near their own
-- resolution.
--
-- No single flat image can answer that. A board big enough to hold twenty 12-megapixel photos
-- at their own resolution would be roughly 20,000px on its long edge — not a canvas, not a
-- JPEG anybody can open, and not something a phone can encode.
--
-- So the board stays the OVERVIEW and each photograph is kept beside it at full resolution.
-- Tap a print on the share page and you get the original file, not a crop of the flattened
-- board. That is what "zoom in and look at the photos" actually means.
--
-- A SNAPSHOT, STILL. Same rule as the board image: the bytes are COPIED into the share's own
-- R2 prefix at share time. A share outlives the trip's storage window, and a link that dies
-- when the trip is cleaned up is not a link.
CREATE TABLE IF NOT EXISTS collage_share_items (
  share_id TEXT NOT NULL REFERENCES collage_shares(id),
  idx INTEGER NOT NULL,                  -- paint order; also the lightbox's order
  kind TEXT NOT NULL DEFAULT 'photo',    -- 'photo' | 'video'
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,      -- the SOURCE's own pixels, not the board's
  height INTEGER NOT NULL DEFAULT 0,

  -- Where this print sits on the flattened board, as a FRACTION of the board image (0..1) plus
  -- its tilt. Fractions rather than pixels so the page can lay hotspots over the image at
  -- whatever size the browser decided to draw it, with no scale factor to get wrong.
  fx REAL NOT NULL DEFAULT 0,
  fy REAL NOT NULL DEFAULT 0,
  fw REAL NOT NULL DEFAULT 0,
  fh REAL NOT NULL DEFAULT 0,
  rot REAL NOT NULL DEFAULT 0,

  PRIMARY KEY (share_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_share_items ON collage_share_items(share_id, idx);
