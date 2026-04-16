ALTER TABLE workspaces
ADD COLUMN project_id BLOB REFERENCES projects(id);

ALTER TABLE workspaces
ADD COLUMN parent_workspace_id BLOB REFERENCES workspaces(id);

CREATE INDEX idx_workspaces_project_id ON workspaces(project_id);
CREATE INDEX idx_workspaces_parent_workspace_id ON workspaces(parent_workspace_id);

UPDATE workspaces
SET project_id = (
        SELECT t.project_id
        FROM tasks t
        WHERE t.id = workspaces.task_id
    ),
    parent_workspace_id = (
        SELECT t.parent_workspace_id
        FROM tasks t
        WHERE t.id = workspaces.task_id
    );

ALTER TABLE sessions
ADD COLUMN initial_prompt TEXT;

UPDATE sessions
SET initial_prompt = COALESCE(
        (
            SELECT cat.prompt
            FROM execution_processes ep
            JOIN coding_agent_turns cat ON cat.execution_process_id = ep.id
            WHERE ep.session_id = sessions.id
              AND cat.prompt IS NOT NULL
            ORDER BY cat.created_at ASC, cat.id ASC
            LIMIT 1
        ),
        CASE
            WHEN sessions.id = (
                SELECT s2.id
                FROM sessions s2
                WHERE s2.workspace_id = sessions.workspace_id
                ORDER BY s2.created_at ASC, s2.id ASC
                LIMIT 1
            ) THEN (
                SELECT t.description
                FROM workspaces w
                JOIN tasks t ON t.id = w.task_id
                WHERE w.id = sessions.workspace_id
            )
            ELSE NULL
        END
    );
