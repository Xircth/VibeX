-- Inline "needs you" cards posted by members into a thread: ask_person
-- questions and approval requests. A card stays pending until the user
-- resolves it; the resolution is posted back to the asking member.
CREATE TABLE IF NOT EXISTS collaboration_cards (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  from_conversation_id TEXT NOT NULL,
  member_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('ask', 'approval')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  resolution_json TEXT,
  message_id TEXT,
  reply_message_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS collaboration_cards_space
  ON collaboration_cards (space_id, status);
CREATE INDEX IF NOT EXISTS collaboration_cards_member
  ON collaboration_cards (member_id, status);
