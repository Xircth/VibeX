CREATE TABLE collaboration_space_collection_items (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  creator_kind TEXT NOT NULL CHECK (creator_kind IN ('agent', 'user')),
  creator_conversation_id TEXT,
  creator_nickname TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('text', 'image', 'file')),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_space_collection_items_space_created
  ON collaboration_space_collection_items (space_id, created_at DESC);

CREATE TABLE collaboration_space_collection_reads (
  item_id TEXT NOT NULL,
  reader_key TEXT NOT NULL,
  reader_kind TEXT NOT NULL CHECK (reader_kind IN ('agent', 'user')),
  reader_conversation_id TEXT,
  reader_nickname TEXT NOT NULL,
  read_count INTEGER NOT NULL DEFAULT 1,
  first_read_at TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (item_id, reader_key)
);

CREATE INDEX idx_space_collection_reads_item
  ON collaboration_space_collection_reads (item_id, last_read_at DESC);
