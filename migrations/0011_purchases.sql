-- 0011: purchases, per-person shares, cached FX rates, and two per-user preferences.
--
-- WHY THIS EXISTS. Four people spend nine days paying for each other's taxis, dinners and
-- hostel rooms in two currencies, and at the end somebody has to work out who owes who.
-- Today that is a pile of receipts and an argument. Here a line is added in moments
-- throughout the trip, with the amount, what was bought and who is splitting it, and the app
-- says who owes who.
--
-- WHAT IS STORED IS WHAT WAS PAID. amount_minor + currency + amount_exp is the fact:
-- S/ 45.00 is S/ 45.00 forever, and "about $13.50" is something the app works out at render
-- time from whatever rate it last managed to fetch. No rate is frozen onto a purchase and no
-- settle-up is ever snapshotted — a deliberate trade: a rate may drift a little, and a total
-- that is generally accurate is enough.
--
-- MONEY IS AN INTEGER COUNT OF MINOR UNITS. Never REAL. The settle-up rests on the shares
-- summing to the amount EXACTLY so that the net balances sum to exactly zero; a float split
-- of 10.00 three ways sums to 10.000000000000002 and the matcher never closes. amount_exp
-- says how many minor digits THIS row's currency has (2 for PEN and USD, 0 for JPY and CLP,
-- 3 for KWD) and it lives on the row rather than in a lookup so that correcting that lookup
-- later cannot silently re-scale money somebody already spent.
--
-- ONE ROW SHAPE FOR EQUAL AND UNEQUAL. purchase_shares carries a weight per included person.
-- Even is every weight 1. "Ada 40, Ben 10" is weights 4000 and 1000 with
-- split_mode='exact', which pins them to minor units and makes them sum to the amount.
-- share_minor is the resolved integer each person owes and it is what the settle-up reads.
-- The API (functions/api/purchases.js) resolves the shares and enforces the one
-- invariant that matters here — SUM(share_minor) = amount_minor — and refuses anything else.
--
-- RE-RUNNABILITY, honestly: this file is ONCE-ONLY, because of the three ALTERs at the foot.
-- SQLite has no ADD COLUMN IF NOT EXISTS and this repo does not do the check-if-it-exists
-- dance. What the ordering buys is a clean failure rather than a half-applied one: everything
-- above the ALTERs is CREATE TABLE / CREATE INDEX IF NOT EXISTS, so a re-run does all of the
-- idempotent work, then dies on the first duplicate column with nothing partial behind it.
-- Only 0001 in this directory is genuinely re-runnable end to end.
--
-- STRICTLY ADDITIVE, and that is a property this file must keep. Between `--remote` and
-- `pages deploy` the OLD code runs against the NEW schema (AGENTS.md records the outage that
-- taught it), so every new column is nullable
-- or defaulted, nothing is dropped, and nothing is renamed.

-- ── purchases ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),

  description TEXT NOT NULL,             -- "what was purchased". Never blank; 200 char cap.
  amount_minor INTEGER NOT NULL,         -- > 0. Integer minor units of `currency`.
  currency TEXT NOT NULL,                -- ISO 4217, uppercase. 'PEN', 'USD'.
  amount_exp INTEGER NOT NULL DEFAULT 2, -- minor digits for THIS row. 0..4.

  paid_by TEXT NOT NULL REFERENCES users(id),   -- whose money left. Not necessarily the author.
  split_mode TEXT NOT NULL DEFAULT 'weight',    -- 'weight' | 'exact' — see §4. Governs ONLY
                                                -- what happens when amount_minor is edited.

  spent_at INTEGER NOT NULL,             -- epoch SECONDS, when the money was spent. The feed's
                                         -- sort key. Defaults to now at entry but is editable,
                                         -- because "the taxi yesterday" is a normal thing to add.

  -- Attachment: all three optional, all three independent, none required: a purchase may go
  -- with a day, an event or a place, or float. The reason is ergonomic — picking a place from
  -- the list beats typing its name — so this
  -- is a shortcut for filling in what it was, not a category step.
  --
  -- ON DELETE SET NULL, and it is not a soft delete: it makes the purchase FLOAT, which is a
  -- state that is already legal. Without it, deleting an event a purchase points at
  -- raises a foreign-key error inside deleteEvent()'s batch, which escapes the handler as a
  -- raw Pages 500 — and store.js classifies >= 500 as TRANSIENT, so the queued delete retries
  -- forever. Declarative, fires inside the existing batch, and needs no change to events.js
  -- or places.js. A purchase that loses its event loses a convenience label and keeps every
  -- bit of its money, which is why it needs none of the kept_for_notes protection notes have.
  day TEXT DEFAULT '',                   -- ISO date, trip-local. util.js dayKey() spelling.
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  place_id TEXT REFERENCES places(id) ON DELETE SET NULL,

  note TEXT DEFAULT '',                  -- 1000 char cap.
  created_by TEXT NOT NULL REFERENCES users(id),   -- the AUTHOR. Permission reads this.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The only query the server ever runs against this table is the snapshot's
-- "everything for this trip, oldest first". Nothing selects by payer, by event or by place —
-- the client holds all ~200 rows in memory and filters there, which is the same reason
-- places is deliberately flat.
CREATE INDEX IF NOT EXISTS idx_purchases_trip ON purchases(trip_id, spent_at, id);

-- ── shares ──────────────────────────────────────────────────────────────────────────────
-- The tuple IS the fact, so there is no surrogate id — the same shape as packing_placements
-- and memory_tags. The composite PK is also what makes a replayed offline write idempotent
-- by construction: re-inserting the same (purchase, person) cannot produce a second share.
--
-- NO trip_id COLUMN. A child table reaches the trip by joining its parent; duplicating it is
-- how two sources of truth for the same fact get out of step.
CREATE TABLE IF NOT EXISTS purchase_shares (
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  user_id TEXT NOT NULL REFERENCES users(id),

  -- WHAT THE PERSON AGREED TO. Under split_mode='weight' it is relative (all 1s = even, 2 =
  -- "counts double"); under 'exact' it IS the minor-unit amount they owe and the set must sum
  -- to amount_minor. Both are integers for the same reason the amount is.
  weight INTEGER NOT NULL,

  -- WHAT THE PERSON OWES, resolved. Always integer minor units of the purchase's currency,
  -- and SUM(share_minor) = purchases.amount_minor is enforced by functions/api/purchases.js
  -- on every write. This column is derivable from (amount_minor, weight) — it is stored
  -- anyway, for the same reason media_usage stores a total it could SUM(): it is what the
  -- settle-up reads on every render, and it is the one place the invariant is materialised
  -- where a query can check it.
  share_minor INTEGER NOT NULL,

  PRIMARY KEY (purchase_id, user_id)
);

-- ── cached exchange rates ───────────────────────────────────────────────────────────────
-- One row per quote currency, always against USD. Server-owned, replaced wholesale, and it
-- rides GET /api/trip's snapshot like note_colors does — the phone gets exactly one request
-- in before the signal goes, and rates that only arrive on their own endpoint are rates that
-- do not exist on the trail.
--
-- rate is REAL and that is not a contradiction of "money is never REAL": a rate is a
-- continuous measurement, like places.lat. It is used once, in one multiplication, whose
-- result is immediately rounded to an integer number of minor units. No stored money is ever
-- a float and no rounding error can accumulate, because nothing is ever written back.
CREATE TABLE IF NOT EXISTS fx_rates (
  base TEXT NOT NULL,                    -- always 'USD'. The column exists so a future
                                         -- provider change is a data change, not a migration.
  quote TEXT NOT NULL,                   -- ISO 4217
  rate REAL NOT NULL,                    -- 1 base buys <rate> quote
  fetched_at INTEGER NOT NULL,           -- epoch seconds, when WE fetched it
  next_at INTEGER NOT NULL DEFAULT 0,    -- epoch seconds, when the provider says to come back
  PRIMARY KEY (base, quote)
);

-- ── ALTERs. Once-only. Everything above this line is re-runnable; these three are not. ──

-- The currencies this trip actually needs, as a JSON array of ISO codes — the same
-- storage shape as places.tags: the list is filtered to the currencies a trip needs. Seeded by
-- POST /api/trip/import; the SNAPSHOT widens it with every currency actually used on a
-- purchase and every member's native currency, so it never needs a write route of its own.
ALTER TABLE trips ADD COLUMN currencies TEXT DEFAULT '[]';

-- Your native currency: the one the settle-up totals are shown in. Per USER, not per trip —
-- every currency is converted to it, and two people on one trip
-- can want two different answers. NULL means "never chosen"; functions/api/me.js answers USD
-- for NULL rather than a null the UI would have to render as nothing.
ALTER TABLE users ADD COLUMN native_currency TEXT;

-- The tab bar layout, per user, as a JSON array of section ids. NULL = today's default
-- (agenda, places, pack, memories, settings), so nobody who never opens the setting sees a
-- change. THE SHAPE OF THIS VALUE IS NOT SETTLED HERE — it is
-- here because there is one migration and a column applied --local only is how production
-- went down once already. Whoever designs the tab registry owns this column's contents and
-- should change this line before 0011 is applied anywhere, not after.
ALTER TABLE users ADD COLUMN tab_layout TEXT;
