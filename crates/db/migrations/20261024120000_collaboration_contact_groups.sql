-- Contact groups: user-defined folders for sidebar chats (group + direct).
-- “未分组” is frontend-only (no row / NULL group).
-- * collaboration_contact_groups: one folder per workspace, ordered by sort_order.
-- * collaboration_thread_contact_groups: thread_id (space id or direct:<member>)
--   -> folder. No row means ungrouped.
--
-- Rollback: drop both tables; older builds ignore them.

CREATE TABLE IF NOT EXISTS collaboration_contact_groups (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collaboration_contact_groups_workspace
  ON collaboration_contact_groups (workspace_id, sort_order);

CREATE TABLE IF NOT EXISTS collaboration_thread_contact_groups (
  thread_id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collaboration_thread_contact_groups_group
  ON collaboration_thread_contact_groups (group_id);
