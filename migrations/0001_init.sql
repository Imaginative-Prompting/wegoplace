-- WeGoPlace initial schema.
-- Apply: npx wrangler d1 execute wegoplace --file=migrations/0001_init.sql [--local|--remote]
-- IF NOT EXISTS throughout so re-application is safe.

-- ── identity (ported from ../reader; passkeys are scoped to rpId wegoplace.com) ──
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  is_admin INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id),
  used_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  max_uses INTEGER DEFAULT 1,
  uses INTEGER DEFAULT 0
);

-- ── trips ──
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starts_on TEXT NOT NULL,          -- ISO date, trip-local
  ends_on TEXT NOT NULL,
  default_tz TEXT NOT NULL,         -- IANA, e.g. America/Lima
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_members (
  trip_id TEXT NOT NULL REFERENCES trips(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT DEFAULT 'member',       -- 'owner' | 'member'
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (trip_id, user_id)
);

-- ── places ─────────────────────────────────────────────────────────────────────
-- Deliberately flat. "Nearby" is client-side distance math over lat/lng plus the
-- near_anchor/walk_minutes pair, NOT a join table — so the fast filter (practical →
-- pharmacy) runs against an array already in memory and works offline.
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  trip_id TEXT REFERENCES trips(id),
  name TEXT NOT NULL,
  name_local TEXT DEFAULT '',
  kind TEXT NOT NULL,               -- food|drink|sight|practical|activity|lodging|transit
  subkind TEXT NOT NULL,
  area TEXT NOT NULL,
  address TEXT NOT NULL,            -- as written locally; readable aloud to a taxi driver
  address_note TEXT DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  gmaps_place_id TEXT DEFAULT '',
  rating REAL DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  price_level INTEGER DEFAULT 0,
  hours TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  website TEXT DEFAULT '',
  why TEXT NOT NULL,                -- one sentence, specific, why it earned a slot
  notes TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',           -- JSON array
  near_anchor TEXT DEFAULT '',      -- id of one of OUR named locations
  walk_minutes INTEGER DEFAULT 0,   -- human walk time over real terrain, not straight-line
  confidence TEXT DEFAULT 'medium',
  source TEXT DEFAULT '',
  is_anchor INTEGER DEFAULT 0,      -- 1 = somewhere the trip actually goes
  verified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_places_trip ON places(trip_id);
CREATE INDEX IF NOT EXISTS idx_places_area ON places(area, kind);

-- ── events ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  starts_at INTEGER NOT NULL,       -- epoch UTC
  ends_at INTEGER,                  -- epoch UTC; NULL = point in time
  tz TEXT NOT NULL,                 -- IANA zone this event is displayed in
  all_day INTEGER DEFAULT 0,
  title TEXT NOT NULL,
  kind TEXT DEFAULT 'plan',         -- flight|meal|lodging|activity|transit|plan
  place_id TEXT REFERENCES places(id),
  detail TEXT DEFAULT '',           -- distilled from confirmation emails
  url TEXT DEFAULT '',
  created_by TEXT NOT NULL,         -- 'seed' for locked events, else users.id
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_trip_start ON events(trip_id, starts_at);

-- Permissions live in the API, but the rule is: edit and delete both require
-- created_by == session user. 'seed' matches no user id, so seeded events are locked
-- for everyone INCLUDING the trip owner — that was the explicit ask.
-- event_notes is the pressure valve: anyone may annotate any event, so nobody has to
-- clone a locked event just to say "running 20 min late".
CREATE TABLE IF NOT EXISTS event_notes (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_event ON event_notes(event_id);

-- ── packing ────────────────────────────────────────────────────────────────────
-- owner = users.id for a private list, or the literal 'group' for the shared one.
CREATE TABLE IF NOT EXISTS packing_items (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  owner TEXT NOT NULL,
  section TEXT NOT NULL,
  label TEXT NOT NULL,
  note TEXT DEFAULT '',
  qty TEXT DEFAULT '',
  done INTEGER DEFAULT 0,
  sort INTEGER DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_packing_owner ON packing_items(trip_id, owner);
