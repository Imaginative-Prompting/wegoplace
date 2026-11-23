-- 0026: a shared board's item keeps the thumbnail of the photograph it was made from.
--
-- A board's page draws each tile at the size it needs. Until now it asked for sizes nothing ever
-- made (every first request a 404, then the original); now there are two: the photograph's own
-- thumbnail (about 480 px, made when it was uploaded as a memory) when a tile needs that or
-- less, else the original. The thumbnail is the memory's, found by the media id the app sends
-- with the item when it shares the board (memory_media.thumb_key), and kept here so the page
-- needs no join. '' (an item shared before this, or by an app that doesn't send the media, or
-- a photograph whose thumbnail upload failed): the page uses the original, never a 404.
--
-- One statement, a new column with its default: no existing row changes meaning, and it can't
-- fail on the live schema (the table has no column of that name). Applied a second time it
-- fails, changing nothing. Not in 0023's list of changes (collage_share_items isn't tracked).

ALTER TABLE collage_share_items ADD COLUMN thumb_key TEXT NOT NULL DEFAULT '';
