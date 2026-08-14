CREATE TABLE conversation_steering (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    expected_turn_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('requested', 'accepted', 'rejected', 'unknown')),
    blocks_json TEXT NOT NULL,
    principal_json TEXT NOT NULL,
    code TEXT,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE (conversation_id, operation_id),
    FOREIGN KEY (conversation_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (expected_turn_id) REFERENCES conversation_turns(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversation_steering_conversation_created
    ON conversation_steering (conversation_id, created_at, id);
