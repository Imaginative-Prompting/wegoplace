-- A flight departs in one timezone and lands in another. events.tz alone renders the
-- arrival in the DEPARTURE zone: DL6077 leaves Lima 12:05 and lands Atlanta 20:35 EDT,
-- but a single-tz render shows 19:35 — an hour early, in the wrong city's clock.
-- end_tz is NULL for everything that does not cross a zone; renderers use (end_tz OR tz).
ALTER TABLE events ADD COLUMN end_tz TEXT;
