-- One emoji reaction per actor on a space or DM message.
-- space_id is a group UUID or a direct:<member_id> thread id.

CREATE TABLE collaboration_message_reactions (
  space_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, message_id, actor)
);

CREATE INDEX IF NOT EXISTS collaboration_message_reactions_lookup
  ON collaboration_message_reactions (space_id, message_id);
