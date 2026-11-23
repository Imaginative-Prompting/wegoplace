-- 0033: the assistant in the trip's group chat (docs/model.md §20), the room §17 left for it.
--
-- A message has a kind:
--   'person'     what someone wrote (every message before this)
--   'assistant'  the assistant's answer to a message that named @assistant: its author is the person who
--                asked (so who may delete it, and who isn't told of it, need no new rule), reply_to the
--                message it answers. While it works, `working` holds the step it is on ("Reading the
--                plans…"), and every phone's chat shows it as the step changes; done, `working` is NULL,
--                the body is the answer and `detail` what it did and whether it stopped short.
--   'shared'     a question and its answer from someone's own conversation with the assistant, put in the
--                chat with one press: `detail` holds exactly those two ({ question, answer }), nothing
--                else of the conversation. It may be longer than a message (the app folds it).
-- Every message that exists is a person's, and answers exactly as before.
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'assistant', 'shared'));
ALTER TABLE messages ADD COLUMN reply_to TEXT;
ALTER TABLE messages ADD COLUMN working TEXT;
ALTER TABLE messages ADD COLUMN detail TEXT;
