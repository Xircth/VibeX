DROP INDEX IF EXISTS idx_sessions_task_id;
DROP INDEX IF EXISTS idx_sessions_workspace_status;
DROP INDEX IF EXISTS idx_sessions_workspace_id_created_at;
DROP INDEX IF EXISTS idx_sessions_workspace_id;

CREATE TABLE sessions_new (
    id              BLOB PRIMARY KEY,
    workspace_id    BLOB NOT NULL,
    executor        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    name            TEXT,
    status          TEXT NOT NULL DEFAULT 'todo'
                    CHECK (status IN ('todo', 'inprogress', 'inreview', 'done', 'archived')),
    task_id         BLOB REFERENCES tasks(id) ON DELETE CASCADE,
    initial_prompt  TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

INSERT INTO sessions_new (
    id,
    workspace_id,
    executor,
    created_at,
    updated_at,
    name,
    status,
    task_id,
    initial_prompt
)
SELECT
    id,
    workspace_id,
    executor,
    created_at,
    updated_at,
    name,
    status,
    task_id,
    initial_prompt
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX idx_sessions_workspace_id ON sessions(workspace_id);
CREATE INDEX idx_sessions_task_id ON sessions(task_id);
CREATE INDEX idx_sessions_workspace_status ON sessions(workspace_id, status);
CREATE INDEX idx_sessions_workspace_id_created_at
ON sessions (workspace_id, created_at DESC);
