-- 0012: per-item framing and trim. NON-DESTRUCTIVE, and that is the whole feature.
--
-- WHY THIS EXISTS. When a memory's items are added or edited, each photo or video can be given
-- a zoom and crop, and a video a range: how much of it plays before it loops. Neither edits the
-- file; they set how it shows across the memories views and the collage, so a long video can
-- still be shared whole as a file while the collage loops a short part.
--
-- So every column here is PRESENTATION STATE that sits BESIDE the media. The bytes in R2 are
-- never touched, never re-encoded, never replaced. Somebody who set a tight crop for the board
-- must still be able to send the whole photograph to a friend, and somebody who loops four
-- seconds of a ninety-second clip must still have the ninety seconds.
--
-- ONE FRAMING PER ITEM, honoured EVERYWHERE: how it shows across the memories views and the
-- collage — the feed, the list, the viewer, the board and the
-- exported board all read these same five numbers. A framing that only applied on one surface
-- would be worse than none, because you would set it looking at one screen and be surprised by
-- every other.
--
-- STRICTLY ADDITIVE and every column nullable or defaulted: between `--remote` and
-- `pages deploy` the OLD code runs against the NEW schema. AGENTS.md records the outage that
-- taught this repo that lesson.

-- The crop, as a focal point plus a zoom, NOT as a rectangle.
--
-- A rectangle would have to be stored in the source image's pixels and re-interpreted for every
-- box it is ever drawn into — and this app draws the same photo into a polaroid, a bare print, a
-- feed card, a list thumbnail and a full-screen viewer, all with different aspect ratios. A
-- focal point and a zoom are aspect-independent: object-fit:cover already picks a window, and
-- these two numbers say where to centre it and how far in to push. Every surface applies them
-- the same way with the arithmetic it already has.
--
-- focal_x/focal_y are 0..1 in the media's own space; 0.5/0.5 is dead centre, which is what
-- cover does today, which is why NULL and 0.5 mean the same thing and no backfill is needed.
ALTER TABLE memory_media ADD COLUMN focal_x REAL;
ALTER TABLE memory_media ADD COLUMN focal_y REAL;

-- 1.0 = fit as today. Above 1 pushes in. Bounded by the API rather than here, because SQLite
-- CHECK constraints cannot be added to an existing table without rewriting it.
ALTER TABLE memory_media ADD COLUMN zoom REAL;

-- The loop window, in SECONDS from the start of the clip. NULL/NULL means the whole thing.
-- Only videos use them; a photo carries NULL and nothing looks at them.
ALTER TABLE memory_media ADD COLUMN trim_start_s REAL;
ALTER TABLE memory_media ADD COLUMN trim_end_s REAL;
