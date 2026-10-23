-- Persistent key-value storage for plugins (shared Host SQLite with plugin_id namespace isolation).
-- Intentionally omits ON DELETE CASCADE against plugin_installations_v4 so uninstalling a plugin
-- with retain_data = true preserves user data across reinstalls, while retain_data = false
-- explicitly purges rows for that plugin_id.
CREATE TABLE IF NOT EXISTS plugin_kv_storage (
    plugin_id  TEXT NOT NULL,
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    PRIMARY KEY (plugin_id, key)
);

CREATE INDEX IF NOT EXISTS idx_plugin_kv_storage_plugin_id
    ON plugin_kv_storage(plugin_id);

-- Quarantine columns on plugin_activation_intents_v4 to prevent boot-time crash loops
-- when a plugin repeatedly fails during activation or rendering.
ALTER TABLE plugin_activation_intents_v4
    ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0, 1));

ALTER TABLE plugin_activation_intents_v4
    ADD COLUMN quarantine_reason TEXT;
