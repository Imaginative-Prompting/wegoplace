-- Airbnb checkout instructions, as structured steps rather than a blob of notes.
-- JSON array of {title, detail}; detail may be empty when the host gave only a heading.
-- Rendered as a checklist on the place page: on the morning you leave, "take the rubbish to
-- level SS" is a task, and burying it inside a paragraph of notes is how it gets missed.
ALTER TABLE places ADD COLUMN checkout TEXT DEFAULT '';
