ALTER TABLE sessions
ADD COLUMN name TEXT;

ALTER TABLE sessions
ADD COLUMN status TEXT NOT NULL DEFAULT 'todo'
CHECK (status IN ('todo', 'inprogress', 'inreview', 'done'));

ALTER TABLE sessions
ADD COLUMN task_id BLOB
REFERENCES tasks(id) ON DELETE CASCADE;

CREATE INDEX idx_sessions_task_id ON sessions(task_id);
CREATE INDEX idx_sessions_workspace_status ON sessions(workspace_id, status);

UPDATE sessions
SET task_id = (
        SELECT w.task_id
        FROM workspaces w
        WHERE w.id = sessions.workspace_id
    ),
    name = (
        SELECT t.title
        FROM workspaces w
        JOIN tasks t ON t.id = w.task_id
        WHERE w.id = sessions.workspace_id
    ),
    status = COALESCE((
        SELECT CASE t.status
            WHEN 'todo' THEN 'todo'
            WHEN 'inprogress' THEN 'inprogress'
            WHEN 'inreview' THEN 'inreview'
            WHEN 'done' THEN 'done'
            WHEN 'cancelled' THEN 'done'
            ELSE 'todo'
        END
        FROM workspaces w
        JOIN tasks t ON t.id = w.task_id
        WHERE w.id = sessions.workspace_id
    ), 'todo');
