-- Rename stored plugin ids from the previous brand (`vibex.*`) to `dimo.*`.
--
-- Installed plugins, activation intents, generations and user state are keyed by
-- plugin id. Without this migration an upgrade would see every previously
-- installed plugin as missing and start from an empty catalog, orphaning the
-- user's activation choices, KV storage and secrets.
--
-- Child tables reference `plugin_v2_registry(plugin_id)`,
-- `plugin_control_registry(plugin_id)`, and `plugin_installations_v4(plugin_id)`
-- with `ON DELETE CASCADE` and no `ON UPDATE CASCADE`. Production opens SQLite
-- with `PRAGMA foreign_keys = ON`, so updating a parent primary key in place
-- fails with SQLITE_CONSTRAINT_FOREIGNKEY (code 787) whenever child rows exist.
-- Insert destination parent rows first, retarget children, then delete old rows.
--
-- The rename is a prefix substitution. Manifest ids were `vibex.<name>` and are
-- now `dimo.<name>`; the one hyphenated id (`vibex-plugin-computer-use`) became
-- `dimo-plugin-computer-use`. Third-party ids that never used the brand prefix
-- are untouched.

-- 1. Plugin v2 registry + FK children
CREATE TEMP TABLE IF NOT EXISTS _dimo_rename_v2_legacy (
    new_plugin_id TEXT PRIMARY KEY,
    legacy_plugin_id BLOB NOT NULL
);
DELETE FROM _dimo_rename_v2_legacy;

INSERT OR IGNORE INTO _dimo_rename_v2_legacy (new_plugin_id, legacy_plugin_id)
SELECT
    CASE
        WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
        ELSE 'dimo.' || substr(plugin_id, 7)
    END,
    legacy_plugin_id
FROM plugin_v2_registry
WHERE (substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use')
  AND legacy_plugin_id IS NOT NULL;

UPDATE plugin_v2_registry
SET legacy_plugin_id = NULL
WHERE (substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use')
  AND legacy_plugin_id IS NOT NULL;

INSERT OR IGNORE INTO plugin_v2_registry (
    plugin_id, schema_version, name, normalized_manifest_json,
    source, membership, legacy_plugin_id, created_at, updated_at
)
SELECT
    CASE
        WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
        ELSE 'dimo.' || substr(plugin_id, 7)
    END,
    schema_version, name, normalized_manifest_json,
    source, membership, NULL, created_at, updated_at
FROM plugin_v2_registry
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_v2_activation
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_v2_activation
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_v2_dependency_state
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_v2_dependency_state
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_v2_skill_state
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_v2_skill_state
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_v2_provider_state
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_v2_provider_state
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

DELETE FROM plugin_v2_registry
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_v2_registry
SET legacy_plugin_id = (
    SELECT l.legacy_plugin_id
    FROM _dimo_rename_v2_legacy l
    WHERE l.new_plugin_id = plugin_v2_registry.plugin_id
)
WHERE legacy_plugin_id IS NULL
  AND EXISTS (
      SELECT 1
      FROM _dimo_rename_v2_legacy l
      WHERE l.new_plugin_id = plugin_v2_registry.plugin_id
        AND NOT EXISTS (
            SELECT 1 FROM plugin_v2_registry existing
            WHERE existing.legacy_plugin_id = l.legacy_plugin_id
        )
  );
DROP TABLE _dimo_rename_v2_legacy;

UPDATE plugin_legacy_evidence
SET mapped_plugin_id = CASE
    WHEN mapped_plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(mapped_plugin_id, 7)
END
WHERE substr(mapped_plugin_id, 1, 6) = 'vibex.' OR mapped_plugin_id = 'vibex-plugin-computer-use';

-- 2. Plugin control plane registry + FK children
INSERT OR IGNORE INTO plugin_control_registry (
    plugin_id, name, version, source_kind, source_path, package_json, created_at, updated_at
)
SELECT
    CASE
        WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
        ELSE 'dimo.' || substr(plugin_id, 7)
    END,
    name, version, source_kind, source_path, package_json, created_at, updated_at
FROM plugin_control_registry
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_control_activation
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_control_activation
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_control_shell_trust
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_control_shell_trust
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_control_runtime_refs
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_control_runtime_refs
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_control_agent_bindings
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_control_agent_bindings
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_control_mcp_bindings
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_control_mcp_bindings
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

DELETE FROM plugin_control_registry
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_control_audit
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

-- 3. Plugin platform v4 packages, installations + FK children
UPDATE OR IGNORE plugin_packages_v4
SET publisher = CASE
        WHEN publisher = 'vibex' THEN 'dimo'
        ELSE publisher
    END,
    plugin_id = CASE
        WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
        ELSE 'dimo.' || substr(plugin_id, 7)
    END,
    manifest_json = CASE
        WHEN NOT json_valid(manifest_json) THEN manifest_json
        WHEN json_extract(manifest_json, '$.publisher') = 'vibex' THEN json_set(
            manifest_json,
            '$.id',
            CASE
                WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
                ELSE 'dimo.' || substr(plugin_id, 7)
            END,
            '$.publisher',
            'dimo'
        )
        ELSE json_set(
            manifest_json,
            '$.id',
            CASE
                WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
                ELSE 'dimo.' || substr(plugin_id, 7)
            END
        )
    END,
    package_json = CASE
        WHEN NOT json_valid(package_json) THEN package_json
        WHEN json_extract(package_json, '$.publisher') = 'vibex' THEN json_set(
            package_json,
            '$.id',
            CASE
                WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
                ELSE 'dimo.' || substr(plugin_id, 7)
            END,
            '$.publisher',
            'dimo'
        )
        ELSE json_set(
            package_json,
            '$.id',
            CASE
                WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
                ELSE 'dimo.' || substr(plugin_id, 7)
            END
        )
    END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_packages_v4
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

INSERT OR IGNORE INTO plugin_installations_v4 (
    plugin_id, publisher, current_package_digest, rollback_package_digest,
    data_retention, installed_at, updated_at
)
SELECT
    CASE
        WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
        ELSE 'dimo.' || substr(plugin_id, 7)
    END,
    CASE
        WHEN publisher = 'vibex' THEN 'dimo'
        ELSE publisher
    END,
    current_package_digest, rollback_package_digest,
    data_retention, installed_at, updated_at
FROM plugin_installations_v4
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_activation_intents_v4
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_activation_intents_v4
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

-- Preserve generation_id so plugin_contributions_v4(generation_id) keeps its FK,
-- while respecting the partial unique index plugin_one_published_generation_v4.
UPDATE plugin_generations_v4
SET state = 'retired'
WHERE (substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use')
  AND state IN ('active', 'active_degraded')
  AND EXISTS (
      SELECT 1
      FROM plugin_generations_v4 AS keep
      WHERE keep.plugin_id = CASE
          WHEN plugin_generations_v4.plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
          ELSE 'dimo.' || substr(plugin_generations_v4.plugin_id, 7)
      END
        AND keep.state IN ('active', 'active_degraded')
  );

UPDATE plugin_generations_v4
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_contributions_v4
SET declaration_json = CASE
        WHEN json_valid(declaration_json)
         AND json_extract(declaration_json, '$.pluginId') = plugin_id
        THEN json_set(
            declaration_json,
            '$.pluginId',
            CASE
                WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
                ELSE 'dimo.' || substr(plugin_id, 7)
            END
        )
        ELSE declaration_json
    END,
    plugin_id = CASE
        WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
        ELSE 'dimo.' || substr(plugin_id, 7)
    END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_runtime_locks_v4
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_runtime_locks_v4
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_agent_bindings_v4
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_agent_bindings_v4
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_mcp_bindings_v4
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_mcp_bindings_v4
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

DELETE FROM plugin_installations_v4
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_operations_v4
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE plugin_audit_v4
SET publisher = CASE
        WHEN publisher = 'vibex' THEN 'dimo'
        ELSE publisher
    END,
    plugin_id = CASE
        WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
        ELSE 'dimo.' || substr(plugin_id, 7)
    END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

-- 4. Standalone plugin namespace tables
UPDATE OR IGNORE plugin_conversation_bindings
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_conversation_bindings
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_scratch_workspaces
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_scratch_workspaces
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';

UPDATE OR IGNORE plugin_kv_storage
SET plugin_id = CASE
    WHEN plugin_id = 'vibex-plugin-computer-use' THEN 'dimo-plugin-computer-use'
    ELSE 'dimo.' || substr(plugin_id, 7)
END
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
DELETE FROM plugin_kv_storage
WHERE substr(plugin_id, 1, 6) = 'vibex.' OR plugin_id = 'vibex-plugin-computer-use';
