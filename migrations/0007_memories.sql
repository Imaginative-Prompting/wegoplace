-- Memories: photo/video sharing. A memory is one card holding N media items plus tags.
-- Same permission spine as everything else: any trip member reads, the author deletes.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  caption TEXT DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_trip ON memories(trip_id, created_at);

CREATE TABLE IF NOT EXISTS memory_media (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  kind TEXT NOT NULL,                -- 'photo' | 'video'
  r2_key TEXT NOT NULL,              -- original, exactly as uploaded
  thumb_key TEXT DEFAULT '',         -- client-generated webp thumb (poster frame for video)
  mime TEXT DEFAULT '',
  width INTEGER DEFAULT 0, height INTEGER DEFAULT 0,
  duration_s REAL DEFAULT 0,         -- video only
  bytes INTEGER DEFAULT 0,
  sort INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_media_memory ON memory_media(memory_id, sort);

-- Tags are rows, not JSON: "pick from tags you or your friends already created" is
-- SELECT DISTINCT tag, and same-tag grouping is a WHERE, not a client-side parse.
CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  tag TEXT NOT NULL,                 -- normalised lowercase, trimmed
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON memory_tags(tag);
