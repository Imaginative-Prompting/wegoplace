-- 0029: a memory carries when it happened, beside when it was posted.
--
-- Photographs a group posts after the trip were all grouped under the day they were posted. Now a
-- memory may carry:
--   day       "YYYY-MM-DD", the trip-zone day it happened (read from the photographs, or chosen);
--   taken_at  seconds, the earliest moment its photographs were taken, where a file says so (a day
--             chosen by hand has none: it never invents a time);
--   at        the order the feed pages in, the server's own (never shown): taken_at, else the last
--             second of `day` in the trip's zone, else NULL for created_at.
-- `created_at` stays when it was posted, so "posted later" is known.
--
-- Three columns, NULL for every memory that exists: each keeps its day exactly (check:rehearsal
-- counts it on the September export). The index pages the feed by when a memory happened. Applied a
-- second time it fails on the first column, changing nothing.
ALTER TABLE memories ADD COLUMN day TEXT;
ALTER TABLE memories ADD COLUMN taken_at INTEGER;
ALTER TABLE memories ADD COLUMN at INTEGER;
CREATE INDEX memories_by_trip_at ON memories (trip_id, COALESCE(at, created_at) DESC, id DESC);
