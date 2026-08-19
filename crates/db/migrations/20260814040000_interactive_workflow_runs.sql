ALTER TABLE workflow_runs
    ADD COLUMN control_state TEXT NOT NULL DEFAULT 'active'
    CHECK (control_state IN ('active', 'pausing', 'paused'));

ALTER TABLE workflow_runs ADD COLUMN pause_reason TEXT;
ALTER TABLE workflow_runs ADD COLUMN paused_at TEXT;
ALTER TABLE workflow_runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE workflow_runs ADD COLUMN fork_step_id TEXT;
ALTER TABLE workflow_runs
    ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'standard'
    CHECK (run_mode IN ('standard', 'debug_node', 'debug_downstream'));

CREATE INDEX idx_workflow_runs_dispatch_control
    ON workflow_runs (control_state, status, dispatch_ready, created_at, id);

CREATE INDEX idx_workflow_runs_parent
    ON workflow_runs (parent_run_id, created_at, id);

ALTER TABLE workflow_step_runs ADD COLUMN candidate_output_json TEXT;
ALTER TABLE workflow_step_runs ADD COLUMN candidate_schema_digest TEXT;
ALTER TABLE workflow_step_runs
    ADD COLUMN awaiting_acceptance INTEGER NOT NULL DEFAULT 0
    CHECK (awaiting_acceptance IN (0, 1));
ALTER TABLE workflow_step_runs
    ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0
    CHECK (awaiting_input IN (0, 1));
ALTER TABLE workflow_step_runs
    ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'execute'
    CHECK (execution_mode IN ('execute', 'reuse', 'exclude'));

CREATE TABLE workflow_run_control_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('pause', 'resume', 'accept_candidate')),
    step_id TEXT,
    payload_digest TEXT NOT NULL,
    principal_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_run_control_operations_run
    ON workflow_run_control_operations (run_id, created_at);
