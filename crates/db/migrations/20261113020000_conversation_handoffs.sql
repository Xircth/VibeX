CREATE TABLE conversation_handoffs (
    id BLOB PRIMARY KEY NOT NULL,
    conversation_id BLOB NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id BLOB NOT NULL UNIQUE REFERENCES conversation_turns(id) ON DELETE CASCADE,
    input_id BLOB,
    source_binding_id BLOB REFERENCES conversation_agent_bindings(id),
    target_binding_id BLOB REFERENCES conversation_agent_bindings(id),
    history_revision INTEGER NOT NULL,
    policy TEXT NOT NULL CHECK (policy IN ('portable', 'fresh')),
    status TEXT NOT NULL CHECK (status IN ('planned', 'sending', 'delivered', 'refused', 'uncertain', 'cancelled')),
    selection_json TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    evidence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
