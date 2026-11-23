-- Removed is not left.
--
-- Someone who leaves a trip on their own comes back by any link that still works. Someone the
-- host removed comes back only by a link made after they were removed: a link posted in the
-- group before then would otherwise walk them straight back in, and the host has no way to
-- know which links they hold.
--
-- "After" is told by the trip's rev, not the clock. The rev goes up by one in every write to
-- the trip (src/trips/rev.js), so a removal and a link made in the same second still have an
-- order, and it is the order they happened in.
--
--   * `trip_members.removed_rev`: the trip's rev at the write that removed them; null for
--     someone on the trip, someone who left on their own, and anyone from before this file
--     (who can't be told apart: they keep the rule for leaving).
--   * `trip_links.created_rev`: the trip's rev at the write that made the link. A link's own
--     `rev` moves when it is used or revoked, so it can't say when the link was made. Links from
--     before this file take their `rev`, which is at least the rev they were made at.
--
-- Run it as one file, once (`ALTER TABLE … ADD COLUMN` can't be run twice).

ALTER TABLE trip_members ADD COLUMN removed_rev INTEGER;
ALTER TABLE trip_links ADD COLUMN created_rev INTEGER NOT NULL DEFAULT 0;
UPDATE trip_links SET created_rev = rev;
