-- Event cards need a visual anchor or the agenda reads as a wall of identical rectangles.
-- Images hang off PLACES, not events: Andenes appears in three lodging events and should not
-- carry three copies of the same photo. Events may override for the rare case where the event
-- is not the place (a pass crossing vs. the camp it is named after).
--
-- Licence fields are not optional. These are third-party photographs and the app is deployed
-- on a public domain; storing the credit and licence alongside the URL is what makes rendering
-- attribution possible at all. A row with an image_url and no image_license is a bug.
ALTER TABLE places ADD COLUMN image_url TEXT DEFAULT '';
ALTER TABLE places ADD COLUMN image_credit TEXT DEFAULT '';
ALTER TABLE places ADD COLUMN image_license TEXT DEFAULT '';
ALTER TABLE places ADD COLUMN image_source TEXT DEFAULT '';

ALTER TABLE events ADD COLUMN image_url TEXT DEFAULT '';
ALTER TABLE events ADD COLUMN image_credit TEXT DEFAULT '';
ALTER TABLE events ADD COLUMN image_license TEXT DEFAULT '';
ALTER TABLE events ADD COLUMN image_source TEXT DEFAULT '';

-- Trek waypoints are places too. elevation_m drives the day-2 profile and is the number
-- everyone asks about on the Inca Trail.
ALTER TABLE places ADD COLUMN elevation_m INTEGER DEFAULT 0;
