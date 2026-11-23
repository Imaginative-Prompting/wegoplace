-- 0039: what broke (src/errors.js). Each kind of error, by its fingerprint: where it came from (a page, the server, /mcp,
-- the cron), its name and cleaned message, our own code's frames, where (a route's pattern), the version and browser it
-- was last seen on, when it was first and last seen, and how many times. Nothing of who, or of any trip. Read only by the
-- accounts ADMIN_ACCOUNTS names (/admin/errors); a kind goes 30 days after it was last seen (the cron).
CREATE TABLE error_groups (
  fingerprint TEXT PRIMARY KEY,   -- 16 hex of sha256 over the error's shape (error-clean.js groupKey), or overflow:<source>
  source TEXT NOT NULL,           -- client | server | mcp | cron
  kind TEXT NOT NULL,             -- error | rejection | sync | exception | overflow
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT NOT NULL,
  place TEXT NOT NULL,            -- a page's pattern (/t/:trip/#/e/:id) or a route's (GET /api/trips/:trip), a cron job's name
  version TEXT NOT NULL,          -- the app's, as last seen (v99), or "" for the server's own
  browser TEXT NOT NULL,          -- its name, major version and system, as last seen ("Safari 26 · iOS")
  first_seen INTEGER NOT NULL,    -- ms
  last_seen INTEGER NOT NULL,     -- ms
  count INTEGER NOT NULL
);
CREATE INDEX error_groups_by_last_seen ON error_groups (last_seen);
