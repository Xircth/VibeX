CREATE TABLE IF NOT EXISTS agent_capability_catalog (
    agent_type TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    controls_json TEXT NOT NULL,
    retrieved_at TEXT NOT NULL DEFAULT (datetime('now')),
    refresh_error_code TEXT,
    PRIMARY KEY (agent_type, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_agent_capability_catalog_latest
    ON agent_capability_catalog (agent_type, retrieved_at DESC);
