CREATE TABLE artifact_revisions (
    id BLOB NOT NULL,
    conversation_id BLOB NOT NULL,
    turn_id BLOB NOT NULL,
    workspace_id BLOB,
    scope_root TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    revision INTEGER NOT NULL CHECK (revision > 0),
    plugin_id TEXT NOT NULL,
    plugin_version TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    tool_lock_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    tool_version TEXT NOT NULL,
    tool_target TEXT NOT NULL,
    tool_sha256 TEXT NOT NULL CHECK (length(tool_sha256) = 64),
    tool_executable_path TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (id, revision),
    FOREIGN KEY (conversation_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_artifact_revisions_location_revision
    ON artifact_revisions(conversation_id, scope_root, relative_path, revision);

CREATE INDEX idx_artifact_revisions_turn
    ON artifact_revisions(conversation_id, turn_id);

CREATE TABLE artifact_event_outbox (
    artifact_id BLOB NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
    PRIMARY KEY (artifact_id, revision),
    FOREIGN KEY (artifact_id, revision)
        REFERENCES artifact_revisions(id, revision) ON DELETE CASCADE
);

CREATE INDEX idx_artifact_event_outbox_pending
    ON artifact_event_outbox(delivered)
    WHERE delivered = 0;

CREATE TABLE artifact_preview_event_outbox (
    event_key TEXT PRIMARY KEY NOT NULL,
    conversation_id BLOB NOT NULL,
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
    FOREIGN KEY (conversation_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_artifact_preview_event_outbox_pending
    ON artifact_preview_event_outbox(delivered)
    WHERE delivered = 0;
