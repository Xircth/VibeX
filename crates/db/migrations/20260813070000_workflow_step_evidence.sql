ALTER TABLE workflow_step_runs ADD COLUMN resolved_input_json TEXT;
ALTER TABLE workflow_step_runs ADD COLUMN resolved_input_digest TEXT;
ALTER TABLE workflow_step_runs ADD COLUMN execution_evidence_json TEXT;
ALTER TABLE workflow_step_runs ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;

CREATE INDEX idx_workflow_step_workspace
    ON workflow_step_runs (workspace_id)
    WHERE workspace_id IS NOT NULL;
