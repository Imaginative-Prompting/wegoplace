-- 0028: where a person's phones are told of new messages in their trips' chats (Web Push, src/push/).
--
-- One row per browser that said yes: the push service's address for it (its endpoint) and the two
-- keys a message is encrypted for. An account's, not a trip's: one phone hears every trip its person
-- is on, but a trip whose chat they muted (trip_members.chat_muted). `words`: whether this phone's
-- lock screen shows what was said (off: who wrote, and in which trip). A subscription the push
-- service says has ended (404, 410) is deleted when a send hears it; deleting the account deletes its
-- rows (src/accounts/delete.js).
--
-- A new table and its index: nothing that exists changes. Applied a second time it fails on the table
-- that exists, changing nothing.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,               -- the endpoint's SHA-256, hex
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  words INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,                   -- the last message the push service took
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_by_user ON push_subscriptions (user_id);
