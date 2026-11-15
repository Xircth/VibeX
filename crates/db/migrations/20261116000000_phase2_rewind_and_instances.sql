-- Phase 2: Multi-instance provider configs, workspace rollback leases, and git checkpoint refs.

CREATE TABLE IF NOT EXISTS provider_instances (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    auth_mode TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(agent_id, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_instances_agent
    ON provider_instances(agent_id);

CREATE TABLE IF NOT EXISTS workspace_leases (
    workspace_id TEXT PRIMARY KEY,
    lease_holder TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

ALTER TABLE session_checkpoints ADD COLUMN git_ref_name TEXT;
ALTER TABLE session_checkpoints ADD COLUMN commit_oid TEXT;
