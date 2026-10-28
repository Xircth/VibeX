CREATE TABLE collaboration_space_events (
  space_id     TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('message','roster','space','turn')),
  message_id   TEXT,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (space_id, seq)
);

CREATE INDEX collaboration_space_events_created
  ON collaboration_space_events(created_at);

ALTER TABLE collaboration_spaces ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collaboration_threads ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
