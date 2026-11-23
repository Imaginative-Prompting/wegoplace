-- 0037: the caps on how many phones, boards, conversations, purchases and exports (checks/limits/rules.mjs holds each).
--   push_subscriptions.seen_at   when a phone was last seen: its subscription sent again, or a notification reaching
--                                it. An account keeps PUSH_PHONES_MAX phones; the 21st replaces the least recently seen.
--   account_exports              each export an account made, for EXPORTS_PER_HOUR (the drain trims them after a day).
-- A column and a table only an account's own routes read: an old Worker reads past both, so it may go before the deploy.
ALTER TABLE push_subscriptions ADD COLUMN seen_at INTEGER;
UPDATE push_subscriptions SET seen_at = COALESCE(sent_at, created_at);
CREATE TABLE account_exports (
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX account_exports_by_user ON account_exports (user_id, at);
