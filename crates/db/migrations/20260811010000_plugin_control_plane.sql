CREATE TABLE plugin_control_registry (
    plugin_id    TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    version      TEXT NOT NULL,
    source_kind  TEXT NOT NULL CHECK (source_kind IN (
        'builtin','snapshot','developer_link','codex_native','claude_code_native'
    )),
    source_path  TEXT NOT NULL,
    package_json TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE plugin_control_activation (
    plugin_id  TEXT PRIMARY KEY REFERENCES plugin_control_registry(plugin_id) ON DELETE CASCADE,
    enabled    INTEGER NOT NULL CHECK (enabled IN (0,1)),
    updated_at TEXT NOT NULL
);

CREATE TABLE plugin_control_shell_trust (
    plugin_id  TEXT PRIMARY KEY REFERENCES plugin_control_registry(plugin_id) ON DELETE CASCADE,
    granted_at TEXT NOT NULL
);

-- Runtime ownership is deliberately independent from plugin membership. Uninstalling a
-- plugin cannot silently remove a user-global executable that another terminal may use.
CREATE TABLE plugin_control_runtime_inventory (
    runtime_id      TEXT PRIMARY KEY,
    version         TEXT NOT NULL,
    executable_path TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE plugin_control_runtime_refs (
    plugin_id        TEXT NOT NULL REFERENCES plugin_control_registry(plugin_id) ON DELETE CASCADE,
    runtime_id       TEXT NOT NULL,
    required_version TEXT,
    PRIMARY KEY (plugin_id, runtime_id)
);

CREATE TABLE plugin_control_agent_bindings (
    plugin_id      TEXT NOT NULL REFERENCES plugin_control_registry(plugin_id) ON DELETE CASCADE,
    agent_id       TEXT NOT NULL,
    desired        INTEGER NOT NULL CHECK (desired IN (0,1)),
    applied        INTEGER NOT NULL CHECK (applied IN (0,1)),
    pending_reason TEXT,
    error_code     TEXT,
    error_message  TEXT,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (plugin_id, agent_id)
);

CREATE TABLE plugin_control_mcp_bindings (
    plugin_id      TEXT NOT NULL REFERENCES plugin_control_registry(plugin_id) ON DELETE CASCADE,
    mcp_id         TEXT NOT NULL,
    agent_id       TEXT NOT NULL,
    desired        INTEGER NOT NULL CHECK (desired IN (0,1)),
    applied        INTEGER NOT NULL CHECK (applied IN (0,1)),
    error_code     TEXT,
    error_message  TEXT,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (plugin_id, mcp_id, agent_id)
);

CREATE TABLE plugin_control_audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id    TEXT,
    operation    TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    created_at   TEXT NOT NULL
);
