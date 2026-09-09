CREATE TABLE conversation_feedback_note (
    id BLOB PRIMARY KEY NOT NULL,
    conversation_id BLOB NOT NULL,
    operation_id BLOB NOT NULL,
    turn_id BLOB,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    delivered_at TEXT,
    salvaged_input_id BLOB,
    UNIQUE (conversation_id, operation_id)
);

CREATE INDEX conversation_feedback_note_conversation_status
    ON conversation_feedback_note (conversation_id, status);
