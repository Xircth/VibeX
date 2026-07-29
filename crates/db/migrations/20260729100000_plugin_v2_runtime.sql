-- Plugin v2 deliberately does not reuse the legacy `plugins` lifecycle
-- columns. Legacy command strings are evidence only and are never an
-- installation contract.
CREATE TABLE plugin_legacy_evidence (
    legacy_plugin_id       BLOB PRIMARY KEY,
    migration_status      TEXT NOT NULL
                              CHECK (migration_status IN ('migration_required','mapped_builtin')),
    mapped_plugin_id       TEXT,
    original_manifest_json TEXT NOT NULL,
    captured_at            TEXT NOT NULL
);

CREATE TABLE plugin_v2_registry (
    plugin_id               TEXT PRIMARY KEY,
    schema_version          INTEGER NOT NULL CHECK (schema_version = 2),
    name                    TEXT NOT NULL,
    normalized_manifest_json TEXT NOT NULL,
    source                  TEXT NOT NULL,
    membership              TEXT NOT NULL CHECK (membership IN ('added','builtin','removed')),
    legacy_plugin_id        BLOB UNIQUE,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);

CREATE TABLE plugin_v2_activation (
    plugin_id   TEXT PRIMARY KEY REFERENCES plugin_v2_registry(plugin_id) ON DELETE CASCADE,
    enabled     INTEGER NOT NULL CHECK (enabled IN (0,1)),
    updated_at  TEXT NOT NULL
);

CREATE TABLE plugin_v2_dependency_state (
    plugin_id       TEXT NOT NULL REFERENCES plugin_v2_registry(plugin_id) ON DELETE CASCADE,
    dependency_id   TEXT NOT NULL,
    state           TEXT NOT NULL
                        CHECK (state IN ('missing','installing','ready','failed','incompatible')),
    version          TEXT,
    executable_path  TEXT,
    error_code       TEXT,
    error_message    TEXT,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (plugin_id, dependency_id)
);

CREATE TABLE plugin_v2_skill_state (
    plugin_id     TEXT NOT NULL REFERENCES plugin_v2_registry(plugin_id) ON DELETE CASCADE,
    skill_id      TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('missing','ready','failed')),
    error_code    TEXT,
    error_message TEXT,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (plugin_id, skill_id)
);

CREATE TABLE plugin_v2_provider_state (
    plugin_id     TEXT NOT NULL REFERENCES plugin_v2_registry(plugin_id) ON DELETE CASCADE,
    provider_id   TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('unavailable','ready','degraded')),
    error_code    TEXT,
    error_message TEXT,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (plugin_id, provider_id)
);

-- Plugin readiness is intentionally absent: it is derived from activation,
-- dependency, skill and provider facts rather than persisted as another truth.
