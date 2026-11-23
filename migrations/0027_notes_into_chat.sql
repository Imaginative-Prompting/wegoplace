-- 0027: notes on plans become messages in the trip's chat (model §8, §17).
--
-- Each note on an event becomes a message about that event: the same id (a different one only if
-- a message already holds it: "note-" before it), its author, its words, the time it was written.
-- A note about the empty time before an event (anchor_kind 'gap') becomes a message about the
-- time before it (about_part 'before'), the place 0024 made for it. The message keeps the event's
-- title as it is now (about_name), as every message about a thing does, so it still says what it
-- was about if the plan goes later. A note can't hang on an event that is gone (event_notes has a
-- foreign key to events), so every note becomes a message: none is dropped.
--
-- The chat's order: per trip, the notes take the next numbers after the chat's own, oldest first
-- (created_at, then id), and the chat's counter and the trip's rev move past them, data_rev with
-- the rev (the snapshot counts the messages about each thing, and carries the newest ones about
-- the time before each plan, which the Agenda writes on it). `from_note`
-- marks them: the people on the trip read them as notes before, so they are never new to anyone
-- (no "New messages" for words written weeks ago).
--
-- Then the notes' change triggers (0023) and the table go: a change from here on never records a
-- note, and removing a plan leaves its messages in the chat. An undo of a change recorded before
-- this that removed notes leaves those notes out, and says why (src/trips/changes.js).
--
-- Applied as ONE file. A second time it fails at its first statement (the column exists),
-- changing nothing.

ALTER TABLE messages ADD COLUMN from_note INTEGER NOT NULL DEFAULT 0;

INSERT INTO messages (trip_id, id, seq, touched, author, body, about_kind, about_id, about_part, about_name, created_at, rev, from_note)
SELECT n.trip_id,
       CASE WHEN EXISTS (SELECT 1 FROM messages m WHERE m.trip_id = n.trip_id AND m.id = n.id) THEN 'note-' || n.id ELSE n.id END,
       t.message_seq + ROW_NUMBER() OVER (PARTITION BY n.trip_id ORDER BY n.created_at, n.id),
       t.message_seq + ROW_NUMBER() OVER (PARTITION BY n.trip_id ORDER BY n.created_at, n.id),
       n.user_id, n.body, 'event', n.event_id,
       CASE WHEN n.anchor_kind = 'gap' THEN 'before' END,
       e.title, n.created_at, t.rev + 1, 1
FROM event_notes n
JOIN events e ON e.trip_id = n.trip_id AND e.id = n.event_id
JOIN trips t ON t.id = n.trip_id;

UPDATE trips
SET message_seq = message_seq + (SELECT COUNT(*) FROM event_notes n WHERE n.trip_id = trips.id),
    rev = rev + 1,
    data_rev = rev + 1
WHERE id IN (SELECT trip_id FROM event_notes);

DROP TRIGGER changes_event_notes_insert;
DROP TRIGGER changes_event_notes_update;
DROP TRIGGER changes_event_notes_delete;
DROP TABLE event_notes;
