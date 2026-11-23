-- 0043: a picture a person draws in place of their initials (src/accounts/avatar.js; the format is
-- public/js/shared/avatar.js).
--   drawings        one row a drawing, named by its hash: the bytes, as the format holds them (16 KiB at most). Two
--                   people who send the same bytes share the row. A row no account points at any more is removed by
--                   the write that let it go (a new picture, back to initials, the account deleted).
--   users.avatar    the hash of the person's picture; NULL for initials, which is everyone until they draw. A guest is
--                   a users row too, so a guest may draw.
-- A table and a column with no default that only the new routes read: an old Worker reads past them, so it may go
-- before the deploy.
CREATE TABLE drawings (
  hash TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
ALTER TABLE users ADD COLUMN avatar TEXT REFERENCES drawings (hash);
CREATE INDEX users_avatar ON users (avatar) WHERE avatar IS NOT NULL;
