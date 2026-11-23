-- The documents a person gives the assistant (src/assistant/documents.js; docs/model.md §20): a planning document
-- attached to one of their own conversations, and the text read out of it once, at upload, for the assistant to read
-- (read_document). A file is its uploader's alone, as the conversation is: nobody else on the trip, the host included,
-- reads it, and the meter's ledger names none.
--
-- ITS BYTES ARE THE HOST'S: the original and its text both count in the host's room (src/trips/storage.js heldSql),
-- reserved by the upload's own conditional insert (fitsSql) before anything reaches the bucket: the original's bytes
-- and what its text may take (text_reserve), settled to the text's real size once it is read.
--
-- Gone with its conversation, with its person's account, with the trip, and when its person leaves the trip: its row
-- here, its two objects through the drain (src/media/drain.js queueFiles), never deleted in the request.
--
-- NO FOREIGN KEYS, as 0032 left every ai_* table out of the trip's key web on purpose: D1 checks keys at once, so a
-- key here would make every delete of a trip or a conversation fail unless it deleted these rows first. Code deletes
-- them instead, on all four ways out (checks/assistant/documents.mjs holds none left behind, both objects queued).
-- A row still 'reading' past the reservation cut (its Worker gone) is settled by the drain's sweep: 'unreadable' if its
-- original is in the bucket, deleted if not. Only CREATEs.

CREATE TABLE ai_files (
  user_id TEXT NOT NULL,                 -- the person who gave it (the conversation's own)
  id TEXT NOT NULL,                      -- chosen by the server
  trip_id TEXT NOT NULL,                 -- from the conversation's own row, never from a request
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,                    -- as the person's file was named, at most 200 characters
  mime TEXT NOT NULL,                    -- what its bytes are, read from them (never from the name)
  bytes INTEGER NOT NULL,                -- the original's
  text_reserve INTEGER NOT NULL,         -- held for its text while it is read (its own bytes for text, Markdown and
                                         -- CSV; DOCUMENT_TEXT_RESERVE for the rest); 0 once read
  text_bytes INTEGER NOT NULL DEFAULT 0, -- its text's, kept beside it
  text_chars INTEGER NOT NULL DEFAULT 0,
  pages INTEGER,                         -- a PDF's or an image's pages, when known
  r2_key TEXT NOT NULL UNIQUE,           -- the original, in MEDIA
  text_key TEXT UNIQUE,                  -- its text, in MEDIA
  state TEXT NOT NULL CHECK (state IN ('reading', 'ready', 'unreadable')),
  why TEXT,                              -- why it couldn't be read, in words for the person
  created_at INTEGER NOT NULL,           -- seconds, as media_objects', so the room's reservation cut means the same
  PRIMARY KEY (user_id, id)
);
CREATE INDEX ai_files_conversation ON ai_files (user_id, conversation_id);
CREATE INDEX ai_files_trip ON ai_files (trip_id);
-- The hour's uploads of a person (ASSISTANT_FILES_PER_HOUR), counted here.
CREATE INDEX ai_files_hour ON ai_files (user_id, created_at);
