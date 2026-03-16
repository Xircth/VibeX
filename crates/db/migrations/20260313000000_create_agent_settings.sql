CREATE TABLE IF NOT EXISTS agent_setting (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_type TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    installed_version TEXT,
    env_json TEXT,
    config_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Initial data
INSERT OR IGNORE INTO agent_setting (agent_type, sort_order) VALUES ('claude_code', 0);
INSERT OR IGNORE INTO agent_setting (agent_type, sort_order) VALUES ('codex', 1);
INSERT OR IGNORE INTO agent_setting (agent_type, sort_order) VALUES ('open_code', 2);
