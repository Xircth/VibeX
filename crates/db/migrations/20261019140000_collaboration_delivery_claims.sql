-- One claim per operation. counts = 1 is a real submit and consumes the
-- hourly cap. counts = 0 records a later operation that folded onto that
-- submit, so a retry still replays after the digest window closes.
-- receipt_json stays null only while the submit is in flight.
CREATE TABLE collaboration_send_claim (
  conversation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  principal_json TEXT NOT NULL,
  receipt_json TEXT,
  counts INTEGER NOT NULL CHECK (counts IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, operation_id)
);

CREATE INDEX collaboration_send_claim_recent
  ON collaboration_send_claim(conversation_id, payload_digest, created_at);

CREATE INDEX collaboration_send_claim_hour
  ON collaboration_send_claim(conversation_id, counts, created_at);

ALTER TABLE collaboration_space_operations
  ADD COLUMN request_json TEXT NOT NULL DEFAULT '';

-- Fingerprint of a durable create. A retry finishes missing rows instead of
-- treating a half-written session as success, and a different request conflicts.
CREATE TABLE collaboration_create_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  caller_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
