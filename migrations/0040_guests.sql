-- 0040: guests (src/accounts/guests.js). A guest is a person who joined a trip by its link with only a name: no passkey,
-- no Google or GitHub, no email; their way in is the session on the phone they joined from. Adding a passkey or a sign-in
-- makes the same person an account (guest goes to 0 in that write).
--   users.guest         1 while the person is a guest. Stored, never guessed from "no way to sign in": a trip's host may
--                       make a one-use link that signs a guest in again, and that must never reach an account.
--   signin_links.made_by  the host who made a link to sign a guest in again on a new phone; NULL for one the site's
--                       operator made (tools/signin-link.mjs).
--   hour_counts         what is limited per hour without a binding that counts that long: guests made per address and per
--                       join link, rejoin links made per host (the drain trims them after a day). The address is kept as a
--                       hash.
-- A column with a default and a table only the new routes read: an old Worker reads past them, so it may go before the deploy.
ALTER TABLE users ADD COLUMN guest INTEGER NOT NULL DEFAULT 0;
ALTER TABLE signin_links ADD COLUMN made_by TEXT;
CREATE TABLE hour_counts (
  kind TEXT NOT NULL,             -- guest-address | guest-link | rejoin-host
  key TEXT NOT NULL,              -- the address's hash, the link's id, the host's account id
  at INTEGER NOT NULL
);
CREATE INDEX hour_counts_by_key ON hour_counts (kind, key, at);
