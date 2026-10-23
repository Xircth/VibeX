CREATE TABLE collaboration_spaces (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by_conversation_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE collaboration_space_members (
  space_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  conversation_id TEXT,
  nickname TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent','user')),
  visible_to_agents INTEGER NOT NULL CHECK (visible_to_agents IN (0,1)),
  PRIMARY KEY (space_id, member_id),
  UNIQUE (space_id, nickname),
  UNIQUE (space_id, conversation_id)
);

CREATE TABLE collaboration_space_messages (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (space_id, seq)
);

CREATE TABLE collaboration_space_deliveries (
  space_message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  input_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','dispatched','failed')),
  PRIMARY KEY (space_message_id, conversation_id)
);

CREATE TABLE collaboration_space_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
