-- v3 item 20: "Inca Trail view needs an 'On person' section alongside Duffel and Day-pack."
--
-- The trail bags modelled who CARRIES the weight — porters take the duffel, you take the
-- day-pack — and left out the third answer, which is the one that matters at a control post:
-- the passport and the cash are on your body, not in either bag. Day 4 starts at 03:30 in the
-- dark and the day-pack goes into storage at Machu Picchu; anything that must not leave you
-- needs a bag that says so.
--
-- PURELY ADDITIVE. Every statement here is an INSERT OR IGNORE or an UPDATE guarded to a row
-- that still carries its factory name, so:
--   * no placement moves. An item's bag on the trail is a decision somebody made, and a
--     migration that re-files things is a migration that loses somebody's rain jacket.
--   * re-running the file is a no-op. D1 has no migration ledger in this project — the README
--     applies these by hand, in order — so every one of them has to survive being applied
--     twice.
--
-- The same two statements exist as a read-time bootstrap in functions/api/trip.js, for
-- accounts that register after this file has already been applied. Deterministic ids
-- (ps_<owner>_trail_person) are what let the two paths converge instead of racing.

-- ── the new bag ─────────────────────────────────────────────────────────────────────────
-- Scoped to `v.id = 'pv_' || v.owner || '_trail'`, i.e. only the DEFAULT trail view. A view
-- somebody created by hand and happened to name "Inca Trail" has a random id and is theirs;
-- this migration has no business adding bags to it.
--
-- sort is MAX+1 within the view rather than a literal 2. One local trail view already has its
-- Day-pack sitting at sort 2 (bags are reorderable, and the up/down buttons rewrite sort), so
-- a literal would tie with an existing row and leave the order of the two decided by name.
INSERT OR IGNORE INTO packing_sections (id, view_id, name, sort)
SELECT 'ps_' || v.owner || '_trail_person',
       v.id,
       'On person',
       (SELECT COALESCE(MAX(x.sort), 1) + 1 FROM packing_sections x WHERE x.view_id = v.id)
  FROM packing_views v
 WHERE v.id = 'pv_' || v.owner || '_trail';

-- ── one name for one idea ───────────────────────────────────────────────────────────────
-- "Leaving home" has carried a bag called "On-person" since 0004. The move sheet shows every
-- view at once — that is the whole point of it — so shipping "On-person" next to "On person"
-- puts the two spellings on screen together and reads as a bug. v3 item 12's rule is that
-- copy is terse and consistent; this is one hyphen.
--
-- Guarded on BOTH the deterministic id and the exact factory name, so a bag anybody renamed
-- is left alone and a second run has nothing left to match.
UPDATE packing_sections
   SET name = 'On person'
 WHERE name = 'On-person'
   AND id IN (SELECT 'ps_' || v.owner || '_home_person'
                FROM packing_views v
               WHERE v.id = 'pv_' || v.owner || '_home');
