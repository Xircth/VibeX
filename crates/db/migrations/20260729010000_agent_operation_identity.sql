ALTER TABLE agent_installation ADD COLUMN active_operation_id TEXT;

CREATE UNIQUE INDEX idx_agent_installation_active_operation_id
    ON agent_installation(active_operation_id)
    WHERE active_operation_id IS NOT NULL;
