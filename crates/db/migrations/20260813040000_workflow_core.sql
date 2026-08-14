CREATE TABLE workflow_definitions (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

CREATE TABLE workflow_definition_versions (
    id TEXT PRIMARY KEY NOT NULL,
    definition_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    digest TEXT NOT NULL,
    normalized_json TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    payload_digest TEXT NOT NULL,
    principal_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE (definition_id, version),
    UNIQUE (definition_id, digest),
    FOREIGN KEY (definition_id) REFERENCES workflow_definitions(id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_versions_definition
    ON workflow_definition_versions (definition_id, version DESC);

CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY NOT NULL,
    definition_version_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted', 'needs_review'
    )),
    input_json TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    payload_digest TEXT NOT NULL,
    principal_json TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    agent_calls_started INTEGER NOT NULL DEFAULT 0,
    dispatch_ready INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_ready IN (0, 1)),
    last_sequence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    FOREIGN KEY (definition_version_id) REFERENCES workflow_definition_versions(id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX idx_workflow_runs_status
    ON workflow_runs (status, created_at, id);

CREATE TABLE workflow_events (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    event_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    operation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE (run_id, sequence),
    UNIQUE (run_id, operation_id),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_events_run
    ON workflow_events (run_id, sequence);

CREATE TABLE workflow_step_runs (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN (
        'pending', 'ready', 'claimed', 'running', 'waiting_approval',
        'completed', 'failed', 'cancelled', 'interrupted', 'needs_review', 'skipped'
    )),
    conversation_id TEXT,
    turn_id TEXT,
    output_json TEXT,
    output_schema_digest TEXT,
    repair_count INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    claim_deadline TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    UNIQUE (run_id, step_id, attempt),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE SET NULL
);

CREATE INDEX idx_workflow_steps_run
    ON workflow_step_runs (run_id, status, step_id, attempt);

CREATE TABLE workflow_ready_steps (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    ready_sequence INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ready', 'claimed')),
    claim_token TEXT,
    claim_deadline TEXT,
    PRIMARY KEY (run_id, step_id, attempt),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_workflow_ready_fifo
    ON workflow_ready_steps (status, ready_sequence, run_id, step_id);

CREATE TABLE workflow_approval_decisions (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    principal_json TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    PRIMARY KEY (run_id, step_id, attempt),
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
