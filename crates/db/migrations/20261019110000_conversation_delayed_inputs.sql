CREATE TABLE conversation_delayed_inputs (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  principal_json TEXT NOT NULL,
  deliver_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','promoted','cancelled','failed')),
  promoted_input_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, operation_id)
);

CREATE INDEX conversation_delayed_inputs_due
  ON conversation_delayed_inputs(status, deliver_at);

-- Counts real submits so the hourly cap and digest replay survive restart.
-- Replays return the stored receipt and do not insert another row.
CREATE TABLE collaboration_send_log (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX collaboration_send_log_target
  ON collaboration_send_log(conversation_id, created_at);
