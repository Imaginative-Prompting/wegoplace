-- WeGoPlace v2 — notes anchoring + the packing restructure.
-- Apply: npx wrangler d1 execute wegoplace --file=migrations/0004_v2.sql [--local|--remote]
--
-- IDEMPOTENCY, STATED HONESTLY. 0001 is IF NOT EXISTS throughout and can be re-run. 0002 and
-- 0003 are plain `ALTER TABLE … ADD COLUMN` and are NOT re-runnable — a second application
-- dies on "duplicate column name". This file matches that reality rather than pretending
-- otherwise: the three ADD COLUMNs below are plain, so 0004 is a once-only migration exactly
-- like 0002 and 0003. Everything after them (CREATE TABLE IF NOT EXISTS, INSERT OR IGNORE,
-- UPDATE) is written to be safely repeatable, so if you do re-run this file the only
-- statement that fails is the first ALTER and nothing gets duplicated behind it. Do not add
-- a "check if the column exists" dance — SQLite has no ADD COLUMN IF NOT EXISTS and D1 has
-- no migration table here; the file order in migrations/ is the record.

-- ── notes: what a note is attached to ──────────────────────────────────────────────────
-- v1 assumed a note hangs off an event. v2 kills user-authored events, so the thing you most
-- often want to annotate is the EMPTY TIME — "arrange the early bag drop" is a task sitting
-- in the 05:00→14:30 hole after landing, not a 510-minute event that swallows the whole gap.
--
-- A gap note anchors to the event that FOLLOWS the gap, never to the one before it. That is
-- the choice that makes the note survive editing on either side: the gap's start moves when
-- the preceding event's end moves, and its end moves when the following event's start moves,
-- but the identity "the run-up to lunch at Mérito" is stable as long as lunch exists. Anchor
-- to the preceding event instead and deleting a flight orphans every note about the wait.
--
-- event_id keeps meaning "the event this row points at", so no second column and no NULLs:
-- anchor_kind reinterprets the same pointer. Existing rows default to 'event', which is what
-- they already meant.
ALTER TABLE event_notes ADD COLUMN anchor_kind TEXT DEFAULT 'event';   -- 'event' | 'gap'

-- ── notes: one fixed colour per person ─────────────────────────────────────────────────
-- Notes render as sticky notes and the colour is how you spot "that one is Bob's" across a
-- day. It has to be stable per person and stable across devices, so it lives on the user row
-- rather than being derived per render.
--
-- NULL means "not assigned yet"; functions/api/trip.js assigns it on first read, from a hash
-- of the user id, skipping any hue a member already holds. The palette it draws from is four
-- hues chosen to stay separable under deuteranopia — a red-green colourblind member, and
-- the whole point of the colour is undone if two of four people land on a pair they cannot
-- split. There is no red/green pair in it at all. The author's initials sit on every sticky
-- as well, so shape/text carries the identity and the colour only reinforces it.
ALTER TABLE users ADD COLUMN note_color TEXT;

-- ── packing: one item set, many overlapping groupings ──────────────────────────────────
-- v1 modelled the trail (Duffel / Day-pack) and therefore could not model the act of
-- packing: the same rain jacket is in the checked bag leaving home AND in the duffel on the
-- trail. Encoding the bag in packing_items.section forced a choice between those two truths.
--
--   item       the thing itself, owned by a person or by 'group'. Now carries a category.
--   view       a named packing context — "Leaving home", "Inca Trail". Owned like an item.
--   section    a bag inside one view — Checked bag / Day-pack / On-person, Duffel / Day-pack.
--   placement  (item, view) -> section. Unique per view. ABSENT is meaningful: an item with
--              no placement in a view is NOT CARRIED on that leg. "Laptop stays in Cusco
--              storage" is a missing row, not a flag, and that is the whole reason placement
--              is its own table instead of a pair of nullable columns on the item.
--
-- Switching views regroups the same items; category gives the sub-grouping inside a section.
-- Moving an item between bags edits ONE placement and never touches the item, so nothing
-- about the item — its label, its qty, its tick — is at risk from a drag.

CREATE TABLE IF NOT EXISTS packing_views (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  owner TEXT NOT NULL,              -- users.id for a private view, or the literal 'group'
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_packing_views_owner ON packing_views(trip_id, owner, sort);

CREATE TABLE IF NOT EXISTS packing_sections (
  id TEXT PRIMARY KEY,
  view_id TEXT NOT NULL REFERENCES packing_views(id),
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_packing_sections_view ON packing_sections(view_id, sort);

-- No surrogate id. The row IS the fact "(item, view) -> section", and the composite primary
-- key is the UNIQUE(item_id, view_id) the contract asks for. It also makes the write
-- naturally idempotent: an offline "move to Day-pack" replayed twice upserts the same row
-- instead of minting a second placement, which is what a uuid key would have done.
CREATE TABLE IF NOT EXISTS packing_placements (
  item_id TEXT NOT NULL REFERENCES packing_items(id),
  view_id TEXT NOT NULL REFERENCES packing_views(id),
  section_id TEXT NOT NULL REFERENCES packing_sections(id),
  PRIMARY KEY (item_id, view_id)
);
CREATE INDEX IF NOT EXISTS idx_packing_placements_section ON packing_placements(section_id);

-- Sub-grouping inside a section, and the one attribute of an item that is true in every
-- view. 'clothes'|'documents'|'electronics'|'toiletries'|'gear'|'meds'|'misc'.
ALTER TABLE packing_items ADD COLUMN category TEXT DEFAULT 'misc';

-- packing_items.section is deliberately NOT dropped. It is the v1 grouping, it is what the
-- backfill below reads, and dropping a column an older cached client still selects turns a
-- stale service worker into a 500. It stops being authoritative here; it does not vanish.

-- ── seed the two default views ─────────────────────────────────────────────────────────
-- Deterministic ids — pv_<owner>_home, ps_<owner>_home_checked — on purpose. The API
-- bootstrap in functions/api/packing.js mints the SAME ids with INSERT OR IGNORE for anyone
-- who registers after this migration ran, so the two paths converge instead of racing to
-- create two "Leaving home" views for the same person. They also stay inside the id charset
-- the API validates ([A-Za-z0-9_.-]{1,64}).
--
-- 'group' gets views too. The shared duffel's tent and stove are packing_items with
-- owner='group', and without a group view they would be the one part of the list that
-- cannot be placed anywhere.
-- The owner list is inlined as a derived table rather than a TEMP table: D1 does not
-- guarantee a temp table survives from one statement of a --file run to the next, and a
-- migration that half-applies is worse than a repeated subquery.
INSERT OR IGNORE INTO packing_views (id, trip_id, owner, name, sort)
SELECT 'pv_' || o.owner || '_home',  t.id, o.owner, 'Leaving home', 0
  FROM (SELECT id AS owner FROM users UNION SELECT 'group') o,
       (SELECT id FROM trips ORDER BY starts_on LIMIT 1) t
UNION ALL
SELECT 'pv_' || o.owner || '_trail', t.id, o.owner, 'Inca Trail',   1
  FROM (SELECT id AS owner FROM users UNION SELECT 'group') o,
       (SELECT id FROM trips ORDER BY starts_on LIMIT 1) t;

INSERT OR IGNORE INTO packing_sections (id, view_id, name, sort)
SELECT 'ps_' || v.owner || '_home_checked', v.id, 'Checked bag', 0
  FROM packing_views v WHERE v.id = 'pv_' || v.owner || '_home'
UNION ALL
SELECT 'ps_' || v.owner || '_home_daypack', v.id, 'Day-pack', 1
  FROM packing_views v WHERE v.id = 'pv_' || v.owner || '_home'
UNION ALL
SELECT 'ps_' || v.owner || '_home_person', v.id, 'On-person', 2
  FROM packing_views v WHERE v.id = 'pv_' || v.owner || '_home'
UNION ALL
SELECT 'ps_' || v.owner || '_trail_duffel', v.id, 'Duffel', 0
  FROM packing_views v WHERE v.id = 'pv_' || v.owner || '_trail'
UNION ALL
SELECT 'ps_' || v.owner || '_trail_daypack', v.id, 'Day-pack', 1
  FROM packing_views v WHERE v.id = 'pv_' || v.owner || '_trail';

-- ── migrate every existing item into "Leaving home" ────────────────────────────────────
-- Nothing is orphaned. An absent placement means "not carried on this leg", which is a
-- statement a person makes deliberately; a migration must not invent it, so every v1 row
-- lands in a bag and the unmatched default is the checked bag.
--
--   Daypack · *        -> Day-pack    (it was already the carry-on)
--   Electronics        -> Day-pack    (lithium batteries are not allowed in the hold)
--   Documents, Money   -> On-person   (passport and cash do not travel in a bag you check)
--   everything else    -> Checked bag
INSERT OR IGNORE INTO packing_placements (item_id, view_id, section_id)
SELECT i.id,
       'pv_' || i.owner || '_home',
       'ps_' || i.owner || '_home_' || CASE
         WHEN i.section LIKE 'Daypack ·%'          THEN 'daypack'
         WHEN i.section = 'Electronics'            THEN 'daypack'
         WHEN i.section IN ('Documents', 'Money')  THEN 'person'
         ELSE 'checked'
       END
FROM packing_items i;

-- ── reconstruct "Inca Trail" from the v1 section names ─────────────────────────────────
-- The v1 sections literally named trail bags ("Duffel · Clothing", "Daypack · Water"), so
-- that grouping is real data and throwing it away would make the restructure a net loss.
-- Only sections that already named a bag are placed here.
--
-- Everything else stays UNPLACED, and it reads correctly: things left in storage, or kept for
-- the city days, are not carried on a trek. Documents and Money DO go in the day-pack — a
-- passport may be checked against a permit on the way, and tips are cash.
INSERT OR IGNORE INTO packing_placements (item_id, view_id, section_id)
SELECT i.id,
       'pv_' || i.owner || '_trail',
       'ps_' || i.owner || '_trail_' || CASE
         WHEN i.section LIKE 'Duffel ·%' THEN 'duffel'
         ELSE 'daypack'
       END
FROM packing_items i
WHERE i.section LIKE 'Duffel ·%'
   OR i.section LIKE 'Daypack ·%'
   OR i.section IN ('Documents', 'Money');

-- ── backfill category ──────────────────────────────────────────────────────────────────
-- Category is the sub-grouping inside a bag, so leaving 82 rows on the 'misc' default would
-- ship the feature switched off. Section gives the broad answer; label keywords correct it.
-- Order is load-bearing — each pass overrides the one before, most specific last — so
-- "Quick-dry towel" filed under Duffel · Sleep and camp still lands in toiletries and
-- "First aid kit and Leukotape" under Hygiene and meds still lands in meds.

-- 1. by v1 section
UPDATE packing_items SET category = CASE
  WHEN section IN ('Documents', 'Money')                        THEN 'documents'
  WHEN section = 'Electronics'                                  THEN 'electronics'
  WHEN section IN ('Daypack · Layers', 'Duffel · Clothing',
                   'Lima and city days')                        THEN 'clothes'
  WHEN section IN ('Daypack · Sun and bugs',
                   'Daypack · Hygiene and meds')                THEN 'toiletries'
  WHEN section IN ('Daypack · Water', 'Duffel · Sleep and camp',
                   'Duffel · Waterproofing',
                   'Duffel · Rented from Alpaca')               THEN 'gear'
  ELSE 'misc'
END;

-- 2. clothes by label — footwear counts; "Speedgoat" and "650 Down" are products, not words
UPDATE packing_items SET category = 'clothes' WHERE
  label LIKE '%shirt%' OR label LIKE '%pants%' OR label LIKE '%socks%' OR label LIKE '%jacket%'
  OR label LIKE '%merino%' OR label LIKE '%gaiters%' OR label LIKE '%buff%' OR label LIKE '%hat%'
  OR label LIKE '%shoes%' OR label LIKE '%slides%' OR label LIKE '%boxer%'
  OR label LIKE '%underwear%' OR label LIKE '%scarf%' OR label LIKE '%clothes%'
  OR label LIKE '%speedgoat%' OR label LIKE '%650 down%' OR label LIKE '%base layer%';

-- 3. gear by label — runs after clothes so "Extra bags for wet or dirty clothes" is a bag
UPDATE packing_items SET category = 'gear' WHERE
  label LIKE '%osprey%' OR label LIKE '%poles%' OR label LIKE '%reservoir%'
  OR label LIKE '%bottle%' OR label LIKE '%earplug%' OR label LIKE '%sleeping%'
  OR label LIKE '%contractor bags%' OR label LIKE '%dry bags%' OR label LIKE '%extra bags%'
  OR label LIKE '%sunglasses%';

-- 4. toiletries by label
UPDATE packing_items SET category = 'toiletries' WHERE
  label LIKE '%sunscreen%' OR label LIKE '%lip balm%' OR label LIKE '%repellent%'
  OR label LIKE '%sanitizer%' OR label LIKE '%toilet paper%' OR label LIKE '%towel%'
  OR label LIKE '%toothbrush%' OR label LIKE '%wipes%';

-- 5. documents by label — '%the bank%' and not '%bank%', which would eat "power bank"
UPDATE packing_items SET category = 'documents' WHERE
  label LIKE '%passport%' OR label LIKE '%insurance%' OR label LIKE '%confirmation%'
  OR label LIKE '%booking reference%' OR label LIKE '%addresses written%'
  OR label LIKE '%soles%' OR label LIKE '%card%' OR label LIKE '%usd%'
  OR label LIKE '%the bank%';

-- 6. electronics by label — after documents so "Phone and power bank" is not filed as money
UPDATE packing_items SET category = 'electronics' WHERE
  label LIKE '%laptop%' OR label LIKE '%power bank%' OR label LIKE '%phone%'
  OR label LIKE '%esim%' OR label LIKE '%charging%' OR label LIKE '%cable%';

-- 7. meds last. Named drugs and the kit that holds them win over every other signal.
UPDATE packing_items SET category = 'meds' WHERE
  label LIKE '%ibuprofen%' OR label LIKE '%imodium%' OR label LIKE '%acetazolamide%'
  OR label LIKE '%leukotape%' OR label LIKE '%first aid%' OR label LIKE '%rehydration%'
  OR label LIKE '%electrolyte%';
