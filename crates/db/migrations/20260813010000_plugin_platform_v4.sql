-- Canonical v4 product-plugin facts. Legacy plugin_control_* tables remain
-- read-only migration inputs until their binding adapters are replaced.
CREATE TABLE plugin_packages_v4 (
    publisher       TEXT NOT NULL,
    plugin_id       TEXT NOT NULL,
    version         TEXT NOT NULL,
    package_digest  TEXT NOT NULL,
    source_kind     TEXT NOT NULL,
    source_path     TEXT NOT NULL,
    manifest_json   TEXT NOT NULL,
    package_json    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (publisher, plugin_id, package_digest)
);

CREATE TABLE plugin_installations_v4 (
    plugin_id              TEXT PRIMARY KEY,
    publisher              TEXT NOT NULL,
    current_package_digest TEXT NOT NULL,
    rollback_package_digest TEXT,
    data_retention         TEXT NOT NULL DEFAULT 'retain'
        CHECK (data_retention IN ('retain','delete_on_uninstall')),
    installed_at           TEXT NOT NULL,
    updated_at             TEXT NOT NULL
);

CREATE TABLE plugin_activation_intents_v4 (
    plugin_id      TEXT PRIMARY KEY REFERENCES plugin_installations_v4(plugin_id) ON DELETE CASCADE,
    enabled        INTEGER NOT NULL CHECK (enabled IN (0,1)),
    target_digest  TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE TABLE plugin_generations_v4 (
    generation_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id      TEXT NOT NULL REFERENCES plugin_installations_v4(plugin_id) ON DELETE CASCADE,
    package_digest TEXT NOT NULL,
    state          TEXT NOT NULL CHECK (state IN ('candidate','active','active_degraded','draining','retired','failed')),
    evidence_json  TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    published_at   TEXT
);

CREATE UNIQUE INDEX plugin_one_published_generation_v4
ON plugin_generations_v4(plugin_id)
WHERE state IN ('active','active_degraded');

CREATE TABLE plugin_contributions_v4 (
    generation_id   INTEGER NOT NULL REFERENCES plugin_generations_v4(generation_id) ON DELETE CASCADE,
    plugin_id       TEXT NOT NULL,
    kind            TEXT NOT NULL,
    contribution_id TEXT NOT NULL,
    declaration_json TEXT NOT NULL,
    readiness       TEXT NOT NULL,
    PRIMARY KEY (generation_id, kind, contribution_id)
);

CREATE TABLE plugin_grants_v4 (
    publisher          TEXT NOT NULL,
    plugin_id          TEXT NOT NULL,
    package_digest     TEXT NOT NULL,
    permission_id      TEXT NOT NULL,
    capability         TEXT NOT NULL,
    scope_json         TEXT NOT NULL,
    trust_tier         TEXT NOT NULL CHECK (trust_tier IN ('declarative','sandboxed_worker','trusted_native')),
    declaration_digest TEXT NOT NULL,
    granted_at         TEXT NOT NULL,
    revoked_at         TEXT,
    PRIMARY KEY (publisher, plugin_id, package_digest, permission_id)
);

CREATE TABLE plugin_runtime_artifacts_v4 (
    runtime_id          TEXT NOT NULL,
    version             TEXT NOT NULL,
    target              TEXT NOT NULL,
    content_digest      TEXT NOT NULL,
    absolute_entrypoint TEXT NOT NULL,
    ownership           TEXT NOT NULL CHECK (ownership IN ('managed','external')),
    installer           TEXT NOT NULL,
    probe_evidence_json TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    PRIMARY KEY (runtime_id, version, target, content_digest)
);

CREATE TABLE plugin_runtime_locks_v4 (
    plugin_id         TEXT NOT NULL REFERENCES plugin_installations_v4(plugin_id) ON DELETE CASCADE,
    package_digest    TEXT NOT NULL,
    runtime_id        TEXT NOT NULL,
    version           TEXT NOT NULL,
    target            TEXT NOT NULL,
    content_digest    TEXT NOT NULL,
    absolute_entrypoint TEXT NOT NULL,
    ownership         TEXT NOT NULL CHECK (ownership IN ('managed','external')),
    probe_evidence_json TEXT NOT NULL,
    PRIMARY KEY (plugin_id, package_digest, runtime_id, target),
    FOREIGN KEY (runtime_id, version, target, content_digest)
      REFERENCES plugin_runtime_artifacts_v4(runtime_id, version, target, content_digest)
      ON DELETE RESTRICT
);

CREATE INDEX plugin_runtime_lock_artifact_v4
ON plugin_runtime_locks_v4(runtime_id, version, target, content_digest);

CREATE TABLE plugin_operations_v4 (
    operation_id  TEXT PRIMARY KEY,
    plugin_id     TEXT,
    kind          TEXT NOT NULL,
    state         TEXT NOT NULL,
    progress_json TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE plugin_audit_v4 (
    sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id     TEXT,
    publisher     TEXT,
    operation_id  TEXT,
    event         TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE plugin_agent_bindings_v4 (
    plugin_id      TEXT NOT NULL REFERENCES plugin_installations_v4(plugin_id) ON DELETE CASCADE,
    agent_id       TEXT NOT NULL,
    desired        INTEGER NOT NULL CHECK (desired IN (0,1)),
    applied        INTEGER NOT NULL CHECK (applied IN (0,1)),
    pending_reason TEXT,
    error_code     TEXT,
    error_message  TEXT,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (plugin_id, agent_id)
);

CREATE TABLE plugin_mcp_bindings_v4 (
    plugin_id      TEXT NOT NULL REFERENCES plugin_installations_v4(plugin_id) ON DELETE CASCADE,
    mcp_id         TEXT NOT NULL,
    agent_id       TEXT NOT NULL,
    desired        INTEGER NOT NULL CHECK (desired IN (0,1)),
    applied        INTEGER NOT NULL CHECK (applied IN (0,1)),
    error_code     TEXT,
    error_message  TEXT,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (plugin_id, mcp_id, agent_id)
);

-- One-time compatibility import. The Rust registry writes all new product-plugin
-- facts to v4; plugin_control_* remains only as the binding FK projection until
-- those Agent/MCP tables receive publisher-aware keys.
INSERT OR IGNORE INTO plugin_packages_v4 (
    publisher, plugin_id, version, package_digest, source_kind, source_path,
    manifest_json, package_json, created_at
)
SELECT
    COALESCE(NULLIF(json_extract(package_json, '$.publisher'), ''), 'legacy.local'),
    plugin_id,
    version,
    'legacy:' || lower(hex(package_json)),
    source_kind,
    source_path,
    COALESCE(json_extract(package_json, '$.manifest'), '{}'),
    package_json,
    created_at
FROM plugin_control_registry;

INSERT OR IGNORE INTO plugin_installations_v4 (
    plugin_id, publisher, current_package_digest, rollback_package_digest,
    installed_at, updated_at
)
SELECT
    plugin_id,
    COALESCE(NULLIF(json_extract(package_json, '$.publisher'), ''), 'legacy.local'),
    'legacy:' || lower(hex(package_json)),
    NULL,
    created_at,
    updated_at
FROM plugin_control_registry;

INSERT OR IGNORE INTO plugin_activation_intents_v4 (
    plugin_id, enabled, target_digest, updated_at
)
SELECT
    r.plugin_id,
    a.enabled,
    'legacy:' || lower(hex(r.package_json)),
    a.updated_at
FROM plugin_control_registry r
JOIN plugin_control_activation a ON a.plugin_id = r.plugin_id;

INSERT INTO plugin_audit_v4 (
    plugin_id, publisher, operation_id, event, evidence_json, created_at
)
SELECT
    r.plugin_id,
    COALESCE(NULLIF(json_extract(r.package_json, '$.publisher'), ''), 'legacy.local'),
    NULL,
    'legacy_shell_trust_observed',
    json_object('packageDigest', 'legacy:' || lower(hex(r.package_json))),
    t.granted_at
FROM plugin_control_registry r
JOIN plugin_control_shell_trust t ON t.plugin_id = r.plugin_id;

INSERT OR IGNORE INTO plugin_agent_bindings_v4
SELECT * FROM plugin_control_agent_bindings;

INSERT OR IGNORE INTO plugin_mcp_bindings_v4
SELECT * FROM plugin_control_mcp_bindings;
