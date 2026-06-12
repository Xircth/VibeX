ALTER TABLE sessions ADD COLUMN external_session_id TEXT;
ALTER TABLE sessions ADD COLUMN agent_type TEXT;

CREATE INDEX idx_sessions_agent_external_session
    ON sessions(agent_type, external_session_id)
    WHERE external_session_id IS NOT NULL;

CREATE INDEX idx_sessions_agent_type
    ON sessions(agent_type)
    WHERE agent_type IS NOT NULL;

CREATE TABLE agent_pending_permissions (
    id BLOB PRIMARY KEY,
    session_id BLOB NOT NULL,
    request_id TEXT NOT NULL,
    tool_call_json TEXT NOT NULL DEFAULT '{}',
    options_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    resolved_at TEXT,
    resolution TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_agent_pending_permissions_request
    ON agent_pending_permissions(session_id, request_id);

CREATE INDEX idx_agent_pending_permissions_session_pending
    ON agent_pending_permissions(session_id, resolved_at);

ALTER TABLE agent_setting ADD COLUMN auto_approve_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (auto_approve_mode IN ('off', 'allow_always', 'yolo'));
