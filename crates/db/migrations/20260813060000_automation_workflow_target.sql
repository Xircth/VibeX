ALTER TABLE automations
    ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'turn'
        CHECK (target_kind IN ('turn', 'workflow'));

ALTER TABLE automations
    ADD COLUMN workflow_launch_spec_json TEXT;

ALTER TABLE automation_runs
    ADD COLUMN workflow_run_id TEXT;

CREATE INDEX idx_automation_runs_workflow_run
    ON automation_runs (workflow_run_id)
    WHERE workflow_run_id IS NOT NULL;
