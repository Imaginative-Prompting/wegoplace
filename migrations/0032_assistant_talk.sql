-- 0032: talking to the assistant (docs/model.md §20): each person's own conversations on a trip.
--
-- A conversation is its person's alone: stored with their account, read only by them (not the host, not
-- the others), in their export, gone with the account, and deleting it deletes it. Nothing here is the
-- trip's: leaving the trip or handing it over doesn't move a conversation to anyone.
--
-- ai_turns: a conversation's turns in order. A person's words (role 'person'); the assistant's answer
-- (role 'assistant': its words, what it did on the trip, each change's id, and whether it stopped short);
-- the steps the loop took on the way are kept on the answer, so a conversation reopened shows them.
--
-- ai_asks: what a trip is asking right now. One row per trip while an ask's loop runs (one ask at a time per
-- trip, §20), taken by one conditional insert and let go when the ask ends; a row past busy_until (its
-- Worker gone) is taken over. The meter's own one-call-per-trip (0031) still holds each call inside it.
CREATE TABLE ai_conversations (
  id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX ai_conversations_trip ON ai_conversations (user_id, trip_id, updated_at);

CREATE TABLE ai_turns (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('person', 'assistant')),
  words TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',        -- JSON: an answer's steps, what it did, its changes, stopped
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, conversation_id, id),
  UNIQUE (user_id, conversation_id, seq)
);

CREATE TABLE ai_asks (
  trip_id TEXT PRIMARY KEY,
  ask_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  busy_until INTEGER NOT NULL
);
