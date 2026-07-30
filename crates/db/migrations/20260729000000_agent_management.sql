PRAGMA foreign_keys = ON;

CREATE TABLE agent_membership (
    agent_id TEXT PRIMARY KEY NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('built_in_profile', 'official_registry', 'retired_legacy')),
    built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0, 1)),
    retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    position INTEGER NOT NULL CHECK (position >= 0),
    retained_metadata_json TEXT,
    retained_icon_svg TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_agent_membership_position
    ON agent_membership(position, agent_id);

CREATE TABLE agent_registry_snapshot (
    id TEXT PRIMARY KEY NOT NULL,
    source_url TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    document_json TEXT NOT NULL,
    document_sha256 TEXT NOT NULL,
    etag TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE agent_registry_entry (
    snapshot_id TEXT NOT NULL REFERENCES agent_registry_snapshot(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    registry_id TEXT NOT NULL,
    version TEXT NOT NULL,
    sort_name TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    distributions_json TEXT NOT NULL,
    icon_svg TEXT,
    PRIMARY KEY (snapshot_id, agent_id),
    UNIQUE (snapshot_id, registry_id)
);

CREATE INDEX idx_agent_registry_entry_sort
    ON agent_registry_entry(snapshot_id, sort_name, agent_id);

CREATE TABLE agent_install_lock (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agent_membership(agent_id) ON DELETE CASCADE,
    registry_version TEXT NOT NULL,
    platform TEXT NOT NULL,
    distribution_kind TEXT NOT NULL,
    resolved_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_agent_install_lock_agent
    ON agent_install_lock(agent_id, created_at DESC);

CREATE TABLE agent_installation (
    agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_membership(agent_id) ON DELETE CASCADE,
    ownership TEXT NOT NULL CHECK (ownership IN ('managed', 'external')),
    lifecycle TEXT NOT NULL,
    current_lock_id TEXT REFERENCES agent_install_lock(id) ON DELETE SET NULL,
    rollback_lock_id TEXT REFERENCES agent_install_lock(id) ON DELETE SET NULL,
    active_operation TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE agent_install_component (
    id TEXT PRIMARY KEY NOT NULL,
    lock_id TEXT NOT NULL REFERENCES agent_install_lock(id) ON DELETE CASCADE,
    component_kind TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    version TEXT NOT NULL,
    sha256 TEXT,
    trust_state TEXT NOT NULL,
    ownership TEXT NOT NULL CHECK (ownership IN ('managed', 'external', 'shared')),
    shared_resource_key TEXT,
    UNIQUE (lock_id, component_kind, absolute_path)
);

CREATE TABLE agent_probe (
    agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_membership(agent_id) ON DELETE CASCADE,
    lifecycle TEXT NOT NULL,
    authentication TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    probed_at TEXT NOT NULL
);

CREATE TABLE agent_diagnostic (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agent_membership(agent_id) ON DELETE CASCADE,
    operation_kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    redacted_output TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_agent_diagnostic_agent_created
    ON agent_diagnostic(agent_id, created_at DESC, id DESC);

CREATE TABLE agent_config_binding (
    agent_id TEXT NOT NULL REFERENCES agent_membership(agent_id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    profile_id TEXT,
    absolute_path TEXT NOT NULL,
    revision TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    recognized_fields_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, provider_id)
);

CREATE TABLE agent_session_default (
    agent_id TEXT NOT NULL REFERENCES agent_membership(agent_id) ON DELETE CASCADE,
    option_id TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, option_id)
);

CREATE TABLE agent_management_migration_state (
    migration_key TEXT PRIMARY KEY NOT NULL,
    completed_at TEXT NOT NULL
);

ALTER TABLE sessions ADD COLUMN agent_id TEXT;

UPDATE sessions
SET agent_id = CASE LOWER(COALESCE(agent_type, executor))
    WHEN 'claudecode' THEN 'claude_code'
    WHEN 'claude-code' THEN 'claude_code'
    WHEN 'claude_code' THEN 'claude_code'
    WHEN 'open_code' THEN 'opencode'
    WHEN 'open_claw' THEN 'openclaw'
    ELSE LOWER(COALESCE(agent_type, executor))
END
WHERE COALESCE(agent_type, executor) IS NOT NULL
  AND TRIM(COALESCE(agent_type, executor)) <> '';

CREATE INDEX idx_sessions_agent_id
    ON sessions(agent_id, external_session_id)
    WHERE agent_id IS NOT NULL;

ALTER TABLE conversation_agent_bindings ADD COLUMN agent_id TEXT;
ALTER TABLE conversation_agent_bindings ADD COLUMN runtime_version TEXT;
ALTER TABLE conversation_agent_bindings ADD COLUMN acp_version TEXT;

UPDATE conversation_agent_bindings
SET agent_id = CASE LOWER(agent_type)
    WHEN 'claudecode' THEN 'claude_code'
    WHEN 'claude-code' THEN 'claude_code'
    WHEN 'claude_code' THEN 'claude_code'
    WHEN 'open_code' THEN 'opencode'
    WHEN 'open_claw' THEN 'openclaw'
    ELSE LOWER(agent_type)
END;

CREATE INDEX idx_conversation_agent_bindings_agent_id
    ON conversation_agent_bindings(agent_id, acp_session_id);

CREATE TABLE retired_agent_history (
    agent_id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    first_seen_at TEXT,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO retired_agent_history
    (agent_id, display_name, first_seen_at, last_seen_at)
SELECT 'openclaw', 'OpenClaw', MIN(created_at), MAX(updated_at)
FROM sessions
WHERE agent_id = 'openclaw'
HAVING COUNT(*) > 0;

INSERT OR IGNORE INTO retired_agent_history
    (agent_id, display_name, first_seen_at, last_seen_at)
SELECT 'hermes', 'Hermes', MIN(created_at), MAX(updated_at)
FROM sessions
WHERE agent_id = 'hermes'
HAVING COUNT(*) > 0;
