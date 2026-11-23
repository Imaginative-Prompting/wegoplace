-- 0047: bug reports (src/bug-reports.js): what someone wrote about something that went wrong, from More › Report a bug
-- (signed in: linked to their account) or from the sign-in page's Report a bug (/report: linked to no one), with what
-- came along, shown to them before it was sent (public/js/shared/bug-rules.js cleanContext): the screen by its route's
-- pattern, never a trip or a thing; the app's version; the kind of device and browser; whether it's the installed app;
-- and the fingerprints of this device's last few kinds of error (error_groups.fingerprint, nothing else of them).
-- A screenshot, if they chose one, redrawn on their device first, is in MEDIA at bug-reports/<id>.
--
-- Read by the site's operator (tools/bug-reports.mjs, and /api/admin/bug-reports for ADMIN_ACCOUNTS). An account's are
-- in its export and go with it (src/accounts/delete.js); every report goes 90 days after it was sent (the cron), its
-- screenshot through the drain. A new table only the new Worker reads: it may go before the deploy. Only a CREATE.
CREATE TABLE bug_reports (
  id TEXT PRIMARY KEY,                    -- random, 16 hex
  user_id TEXT,                           -- the account it came from, or NULL: sent signed out
  text TEXT NOT NULL,                     -- what happened, as they wrote it (BUG_LIMITS.text characters at most)
  screen TEXT NOT NULL,                   -- "/t/:trip/#/split", "/login": a route's pattern (error-clean.js placeOf), or ''
  version TEXT NOT NULL,                  -- the app's version on that device ("v143"), or ''
  browser TEXT NOT NULL,                  -- "Safari 26 · iOS", from the request (error-clean.js coarseBrowser)
  device TEXT NOT NULL CHECK (device IN ('phone', 'tablet', 'computer', '')),
  installed INTEGER NOT NULL DEFAULT 0,   -- 1: the app from the Home Screen, 0: a browser's tab
  recent_errors TEXT NOT NULL DEFAULT '[]', -- JSON: up to 5 error_groups fingerprints this device was told, newest first
  screenshot_key TEXT,                    -- bug-reports/<id> in MEDIA, or NULL
  screenshot_type TEXT,                   -- image/png, image/jpeg or image/webp, read from its own bytes
  screenshot_size INTEGER,
  state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'seen', 'triaged', 'closed')),
  triage TEXT CHECK (triage IN ('bug', 'request')),  -- the operator's call once triaged, or NULL
  note TEXT,                              -- the operator's note (marking or closing it)
  created_at INTEGER NOT NULL,            -- seconds
  closed_at INTEGER                       -- seconds
);
CREATE INDEX bug_reports_user ON bug_reports (user_id, created_at);
CREATE INDEX bug_reports_state ON bug_reports (state, created_at);
CREATE INDEX bug_reports_created ON bug_reports (created_at);
