-- Remove OAuth/Auth infrastructure and remote_project_id fields

-- Drop shared_activity_cursors table (depends on remote_project_id concept)
DROP TABLE IF EXISTS shared_activity_cursors;

-- Drop shared_tasks table (depends on remote_project_id)
DROP TABLE IF EXISTS shared_tasks;

-- Note: shared_task_id was already removed by migration 20260113144821_remove_shared_tasks.sql

-- Remove remote_project_id from projects (requires table recreation due to SQLite limitations)
COMMIT;

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE projects_new (
    id                        BLOB PRIMARY KEY,
    name                      TEXT NOT NULL,
    default_agent_working_dir TEXT DEFAULT '',
    created_at                TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
    updated_at                TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

INSERT INTO projects_new (id, name, default_agent_working_dir, created_at, updated_at)
SELECT id, name, default_agent_working_dir, created_at, updated_at
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

PRAGMA foreign_key_check;

COMMIT;

PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;
