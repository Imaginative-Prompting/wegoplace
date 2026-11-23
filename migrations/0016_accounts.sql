-- 0016: accounts, made over. Anyone can make an account (no invite code); an account signs in with a
-- passkey, Google or GitHub; a sign-in on a browser is a session row here, not a signed cookie.
--
-- Times in the new tables are seconds, like every other table in this database.
--
-- WHAT HAPPENS TO THE ACCOUNTS THAT EXIST
--   Every account keeps its id, its name, its settings and its passkeys. `credentials` already
--   held a passkey as the credential id and the COSE public key, both base64url, which is what
--   `passkeys` holds, so the rows are copied as they are and nobody registers again.
--   The name those accounts typed to sign in is kept in `username`, so "sign in with your
--   username" still works for a passkey the device can't find by itself. Accounts made after
--   this have no username.
--
-- `users` is rebuilt because its `name` was UNIQUE and a display name isn't: two people may be
-- called the same. SQLite can't drop that from a column, so the table is made again. Other tables
-- point at users(id); their checks wait until the end of this file (defer_foreign_keys), by which
-- time every account is back under the same id.

PRAGMA defer_foreign_keys = true;

-- Left behind only if this file was once run outside a transaction, where it stops at the DROP
-- below having made this copy and changed nothing else.
DROP TABLE IF EXISTS accounts_moving;

CREATE TABLE accounts_moving AS
  SELECT id, name, is_admin, created_at, note_color, initials, native_currency, tab_layout FROM users;

DROP TABLE users;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,               -- shown to the people on your trips; two accounts may share one
  username TEXT UNIQUE,             -- only accounts from before this file: the name they sign in by
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  note_color TEXT,
  initials TEXT,
  native_currency TEXT,
  tab_layout TEXT,
  -- A deleted account keeps this row, with its name and nothing else, because the money it paid
  -- and owed is part of other people's balances and has to stay under the name it had. It can't
  -- sign in: its passkeys, identities, sessions and email are gone.
  deleted_at INTEGER
);

INSERT INTO users (id, name, username, is_admin, created_at, note_color, initials, native_currency, tab_layout)
  SELECT id, name, name, COALESCE(is_admin, 0), created_at, note_color, initials, native_currency, tab_layout
  FROM accounts_moving;

DROP TABLE accounts_moving;

-- ── passkeys ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,              -- the credential id, base64url
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,         -- the COSE public key, base64url
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                  -- JSON array, as the browser reported them; NULL when it wasn't recorded
  device_type TEXT,                 -- 'singleDevice' | 'multiDevice'; NULL when it wasn't recorded
  backed_up INTEGER,                -- 1 when the passkey is synced; NULL when it wasn't recorded
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

INSERT INTO passkeys (id, user_id, public_key, counter, created_at)
  SELECT id, user_id, public_key, COALESCE(counter, 0), created_at FROM credentials;

DROP TABLE credentials;

-- ── sessions ───────────────────────────────────────────────────────────────────────────────
-- The cookie holds a random token; only its sha256 is here, so reading this table signs nobody in.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,      -- moved forward while the session is in use
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Before this file a sign-in was a signed cookie with nothing kept here. A browser still holding
-- one is given a session in its place (src/accounts/old-cookie.js), but only for an account on
-- this list: the accounts that existed when this file ran. "Sign out everywhere" takes an
-- account off it. The last such cookie runs out 180 days after this file is applied; then the
-- table and that file can go.
CREATE TABLE old_cookie_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id)
);
INSERT INTO old_cookie_accounts (user_id) SELECT id FROM users;

-- ── things that wait a few minutes ─────────────────────────────────────────────────────────
-- A passkey ceremony's challenge, a trip to Google or GitHub that hasn't come back yet, and a
-- sign-in nobody has used before, waiting for its owner to make an account or add it to theirs.
-- Each is named by a short-lived cookie and taken once.
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,              -- the cookie's value
  kind TEXT NOT NULL,               -- 'register' | 'login' | 'add-passkey' | 'oauth' | 'pending'
  challenge TEXT NOT NULL,          -- the challenge, or the waiting thing as JSON
  user_id TEXT,                     -- who it is for, when that is known
  user_name TEXT,
  expires_at INTEGER NOT NULL
);

-- ── Google and GitHub ──────────────────────────────────────────────────────────────────────
-- A provider's own id for a person (Google's `sub`, GitHub's numeric id): never an email or a
-- username, which change hands. No email is read or kept, and nothing is ever joined by email.
CREATE TABLE identities (
  provider TEXT NOT NULL,           -- 'google' | 'github'
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT,                       -- shown to its owner so two can be told apart
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

-- ── the way back by hand ───────────────────────────────────────────────────────────────────
-- A one-use link the site's operator makes for someone who has lost every way to sign in. Only
-- the token's sha256 is here. Opening the link signs that one account in, once.
CREATE TABLE signin_links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- ── an email on the account ────────────────────────────────────────────────────────────────
-- For getting back in when a passkey is lost, and nothing else: never a way to sign in by
-- itself, never a link between accounts, never shown to anyone. One per account, and an address
-- on one account only.
CREATE TABLE account_emails (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  email TEXT NOT NULL UNIQUE,       -- trimmed, in small letters
  verified_at INTEGER NOT NULL,     -- only a confirmed address is kept
  created_at INTEGER NOT NULL
);

-- A 6-digit code sent to an address: to confirm it for an account, or to get back into the
-- account it is on. Only its hash is kept; it lasts 15 minutes, takes 5 tries, and is gone once
-- used. A code asked for by an address on no account keeps a row too (user_id NULL), so asking
-- never tells anyone whether an address is known.
CREATE TABLE email_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('confirm', 'recover')),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX email_codes_user ON email_codes(user_id, created_at);

-- Every code sent in the last hour, by the address's hash and by the account that asked: what
-- the limit of 5 an hour is counted on.
CREATE TABLE email_sends (
  address_hash TEXT NOT NULL,
  user_id TEXT,
  sent_at INTEGER NOT NULL
);
CREATE INDEX email_sends_address ON email_sends(address_hash, sent_at);
CREATE INDEX email_sends_user ON email_sends(user_id, sent_at);

-- ── invite codes are gone ──────────────────────────────────────────────────────────────────
-- An account no longer needs one. Joining a trip is its own thing, with its own links.
DROP TABLE invites;
