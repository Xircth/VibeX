-- Phase 2: one member, several sessions, one repo. Default write_isolated:
-- every extra session of the member in the same workspace gets its own
-- worktree workspace (recorded in member_session_workspaces). Optional
-- write_serialized: sessions share the checkout and take turns through a
-- per (member, workspace) lease.
--
-- Rollback: drop member_write_leases and member_session_workspaces; the
-- write_access column is ignored by older builds.

ALTER TABLE collaboration_members
  ADD COLUMN write_access TEXT NOT NULL DEFAULT 'write_isolated'
  CHECK (write_access IN ('write_isolated', 'write_serialized'));

CREATE TABLE member_session_workspaces (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  member_id TEXT NOT NULL REFERENCES collaboration_members(id) ON DELETE CASCADE,
  parent_workspace_id TEXT NOT NULL,
  isolated_workspace_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE member_write_leases (
  member_id TEXT NOT NULL REFERENCES collaboration_members(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (member_id, workspace_id)
);
