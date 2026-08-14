CREATE TABLE workflow_review_decisions (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    payload_digest TEXT NOT NULL,
    decision_kind TEXT NOT NULL CHECK (decision_kind IN ('retry', 'accept', 'skip', 'cancel')),
    principal_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_review_decisions_run
    ON workflow_review_decisions (run_id, created_at);

ALTER TABLE workflow_approval_decisions
    ADD COLUMN payload_digest TEXT NOT NULL DEFAULT '';

CREATE TABLE workflow_cancel_operations (
    run_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    payload_digest TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
