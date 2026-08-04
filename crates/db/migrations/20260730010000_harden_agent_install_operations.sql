CREATE TABLE agent_install_operation (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agent_membership(agent_id) ON DELETE CASCADE,
    operation_kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')
    ),
    frozen_plan_json TEXT NOT NULL,
    host_instance_id TEXT NOT NULL,
    heartbeat_at TEXT,
    staging_path TEXT,
    resource_claims_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_agent_install_operation_active_agent
    ON agent_install_operation(agent_id)
    WHERE status IN ('queued', 'running');

CREATE TABLE agent_install_resource_lease (
    resource_key TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL
        REFERENCES agent_install_operation(id) ON DELETE CASCADE,
    acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_agent_install_resource_lease_operation
    ON agent_install_resource_lease(operation_id);
