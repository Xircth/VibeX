ALTER TABLE workflow_step_runs
    ADD COLUMN user_intervened INTEGER NOT NULL DEFAULT 0
    CHECK (user_intervened IN (0, 1));

