-- 0035: the trip's changes by their rev, so a snapshot finds the newest change a person hasn't made by walking
-- from the newest end and stopping at the first (src/trips/changes.js newestChangeFor). Without it the snapshot
-- read every change of the last 30 days to take the largest rev: 1,500 rows on a busy trip, on every phone's
-- every refresh (tools/trip-cost.mjs). An index only: nothing read or written changes, and an old Worker
-- reads past it, so it may go before the deploy.
CREATE INDEX trip_changes_by_rev ON trip_changes (trip_id, rev);
