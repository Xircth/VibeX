CREATE TABLE agent_connections (
    id              TEXT PRIMARY KEY,
    agent_type      TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    status          TEXT NOT NULL,
    working_dir     TEXT NOT NULL,
    status_message  TEXT,
    snapshot_json   TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX idx_agent_connections_workspace_id
ON agent_connections(workspace_id);

CREATE TABLE agent_sessions (
    id                  TEXT PRIMARY KEY,
    connection_id       TEXT NOT NULL,
    workspace_id        TEXT NOT NULL,
    acp_session_id      TEXT NOT NULL,
    status              TEXT NOT NULL,
    active_prompt_id    TEXT,
    queued_prompt_ids   TEXT NOT NULL DEFAULT '[]',
    snapshot_json       TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    FOREIGN KEY (connection_id) REFERENCES agent_connections(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_sessions_connection_id
ON agent_sessions(connection_id);

CREATE INDEX idx_agent_sessions_workspace_id
ON agent_sessions(workspace_id);

CREATE TABLE agent_prompts (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    status          TEXT NOT NULL,
    status_json     TEXT NOT NULL,
    text_preview    TEXT NOT NULL,
    snapshot_json   TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_prompts_session_id
ON agent_prompts(session_id);

CREATE TABLE agent_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence        INTEGER NOT NULL,
    workspace_id    TEXT NOT NULL,
    connection_id   TEXT NOT NULL,
    session_id      TEXT,
    event_kind      TEXT NOT NULL,
    event_json      TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE INDEX idx_agent_events_workspace_sequence
ON agent_events(workspace_id, sequence);

CREATE INDEX idx_agent_events_session_sequence
ON agent_events(session_id, sequence);

CREATE TABLE agent_permissions (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    connection_id   TEXT NOT NULL,
    status          TEXT NOT NULL,
    request_json    TEXT NOT NULL,
    response_json   TEXT,
    created_at      TEXT NOT NULL,
    responded_at    TEXT,
    FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (connection_id) REFERENCES agent_connections(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_permissions_session_status
ON agent_permissions(session_id, status);

CREATE TABLE agent_terminals (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT,
    session_id      TEXT,
    source          TEXT NOT NULL,
    status          TEXT NOT NULL,
    title           TEXT NOT NULL,
    command         TEXT NOT NULL,
    cwd             TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    released_at     TEXT
);

CREATE INDEX idx_agent_terminals_workspace_id
ON agent_terminals(workspace_id);

CREATE TABLE agent_history_imports (
    id                  TEXT PRIMARY KEY,
    source_agent        TEXT NOT NULL,
    external_session_id TEXT NOT NULL,
    title               TEXT,
    workspace_path      TEXT,
    raw_source_path     TEXT,
    message_count       INTEGER NOT NULL DEFAULT 0,
    raw_json            TEXT NOT NULL,
    imported_at         TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_agent_history_imports_source_session
ON agent_history_imports(source_agent, external_session_id);

CREATE TABLE agent_installs (
    agent_type      TEXT PRIMARY KEY,
    status          TEXT NOT NULL,
    version         TEXT,
    details_json    TEXT NOT NULL DEFAULT '{}',
    updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE TABLE agent_config_profiles (
    id              TEXT PRIMARY KEY,
    agent_type      TEXT NOT NULL,
    scope           TEXT NOT NULL,
    path            TEXT NOT NULL,
    content_json    TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE INDEX idx_agent_config_profiles_agent_scope
ON agent_config_profiles(agent_type, scope);
