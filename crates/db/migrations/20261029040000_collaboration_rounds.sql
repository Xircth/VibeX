CREATE TABLE collaboration_rounds (
  id               TEXT PRIMARY KEY NOT NULL,
  space_id         TEXT NOT NULL,
  root_message_id  TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('open','closing','closed','superseded')),
  current_ordinal  INTEGER NOT NULL DEFAULT 0,
  deadline_at      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX collaboration_rounds_open
  ON collaboration_rounds(space_id, state) WHERE state IN ('open','closing');

ALTER TABLE collaboration_turns ADD COLUMN round_id TEXT;
ALTER TABLE collaboration_turns ADD COLUMN round_ordinal INTEGER;
ALTER TABLE collaboration_turns ADD COLUMN error_code TEXT;

ALTER TABLE collaboration_space_deliveries ADD COLUMN round_id TEXT;
ALTER TABLE collaboration_space_deliveries ADD COLUMN round_ordinal INTEGER;
