CREATE TABLE conversation_relations (
    id TEXT PRIMARY KEY NOT NULL,
    parent_conversation_id TEXT NOT NULL,
    child_conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('delegation', 'fork', 'workflow_step')),
    visibility TEXT NOT NULL CHECK (visibility IN ('visible', 'hidden')),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE (parent_conversation_id, child_conversation_id, kind),
    FOREIGN KEY (parent_conversation_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (child_conversation_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversation_relations_parent
    ON conversation_relations (parent_conversation_id, created_at, id);
CREATE INDEX idx_conversation_relations_child
    ON conversation_relations (child_conversation_id, created_at, id);
