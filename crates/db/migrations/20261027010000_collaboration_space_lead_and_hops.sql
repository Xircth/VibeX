-- Optional group lead for default (no-@) routing, hop tracking on space
-- messages, and system notices when a hard collaboration cap is hit.
-- Existing spaces keep lead_member_id NULL. Existing messages keep hop 0
-- and root_id = id so old groups keep working after migrate.

ALTER TABLE collaboration_spaces ADD COLUMN lead_member_id TEXT;

PRAGMA foreign_keys = OFF;

CREATE TABLE collaboration_space_messages_new (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'user'
    CHECK (origin IN ('user', 'agent', 'system')),
  root_id TEXT,
  hop INTEGER NOT NULL DEFAULT 0,
  UNIQUE (space_id, seq)
);

INSERT INTO collaboration_space_messages_new
  (id, space_id, seq, envelope_json, created_at, origin, root_id, hop)
SELECT id, space_id, seq, envelope_json, created_at, origin, id, 0
FROM collaboration_space_messages;

DROP TABLE collaboration_space_messages;
ALTER TABLE collaboration_space_messages_new RENAME TO collaboration_space_messages;

CREATE INDEX IF NOT EXISTS collaboration_space_messages_space_seq
  ON collaboration_space_messages (space_id, seq);
CREATE INDEX IF NOT EXISTS collaboration_space_messages_root
  ON collaboration_space_messages (space_id, root_id);

PRAGMA foreign_keys = ON;
