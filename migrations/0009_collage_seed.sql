-- 0009: per-trip collage seed.
--
-- The collage layout engine (public/js/collage-layout.js) is provably deterministic given a
-- seed, but nothing stored one, so every mount could produce a different board. The seed lives
-- on the trip rather than in localStorage so that everyone on the trip sees the SAME
-- arrangement — a collage you describe to someone should be the collage they open.
--
-- collage_version pins LAYOUT_VERSION at the time the seed was minted. If the engine's geometry
-- changes in a future release, a differing version is the signal that the board legitimately
-- moved, rather than a bug.
--
-- Additive. No ALTER of existing columns, no re-CREATE. Safe to re-run.
ALTER TABLE trips ADD COLUMN collage_seed TEXT;
ALTER TABLE trips ADD COLUMN collage_version INTEGER;
