ALTER TABLE workflow_step_runs
ADD COLUMN waiting_interaction INTEGER NOT NULL DEFAULT 0
CHECK (waiting_interaction IN (0, 1));
