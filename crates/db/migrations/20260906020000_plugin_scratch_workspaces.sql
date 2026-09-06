-- One scratch Workspace per plugin so a plugin tab can host Conversations
-- without borrowing the user's coding workspace. Listings hide these projects.
CREATE TABLE plugin_scratch_workspaces (
    plugin_id TEXT PRIMARY KEY,
    project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    workspace_id BLOB NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
