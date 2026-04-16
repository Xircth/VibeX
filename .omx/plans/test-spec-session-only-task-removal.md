# Test Spec: Session-Only Model Cutover

## Scope

This spec validates the removal of the task layer and the replacement model `Project -> Workspace -> Session`.

## Testable Requirements

1. `workspaces.project_id` is the source of project ownership.
2. Project-level creation can create/start a session without creating a task.
3. Existing-workspace new-session creation still works.
4. Reused non-worktree workspace matching still works for identical repo-target mappings.
5. Fresh execution prompt comes from `session.initial_prompt`.
6. Project views and streams render without task APIs or task routes.
7. Workspace parent-child relationships survive the cutover.
8. Session deletion and workspace deletion semantics are distinct and enforced.

## Test Matrix

### Backend migration

- Apply migration on a database with:
  - task-backed workspaces
  - multiple sessions per workspace
  - parent workspace relationships
  - task-linked images
  - task-only rows with no workspace/session descendants
  - workspace rows with no session descendants
- Assert:
  - workspaces receive `project_id`
  - sessions receive `initial_prompt`
  - no orphaned execution process or image references remain
  - workspace lineage is preserved from previous task-backed parent links
  - session `initial_prompt` backfill follows deterministic precedence:
    - first user prompt if present
    - task description only for earliest or synthetic seed session
    - null only for promptless secondary sessions
  - discarded task-only rows are counted in migration logs
  - each legacy `task_images` row becomes deduped `workspace_images` for every associated workspace and never becomes a session-owned image during migration

### Backend create/start

- Create session with `workspace_spec` and `use_worktree = true`
  - expect new workspace
  - expect new session
  - expect execution process tied to session
- Create session with `workspace_spec` and `use_worktree = false` on matching repo mapping
  - expect workspace reuse
  - expect new session in reused workspace
- Create session with `workspace_id`
  - expect no new workspace
  - expect session history isolated from existing sessions

### Query and stream behavior

- Query project workspaces without any task join
- Query session summaries without task title fallback
- Subscribe to project session/workspace stream and verify payload shape contains no task fields
- Verify project stream patch application works for:
  - workspace add/update/remove
  - session add/update/remove
  - duplicate patch suppression
  - stale patch handling
  - snapshot-before-patch ordering under concurrent updates

### Frontend behavior

- Open project view and verify it renders without `useProjectTasks`
- Create project-level session from UI
- Create additional session within existing workspace
- Switch between sessions and verify follow-up/log isolation
- Navigate parent/child workspace relationship UI
- Delete a session and verify the workspace remains when other sessions exist
- Delete a workspace and verify the UI blocks or proceeds according to cleanup policy
- Verify old task route entrypoints are removed or explicitly redirected to the new project session view

## Required Test Files / Areas

- backend migration or model tests under `crates/db` / `src-tauri`
- frontend tests near:
  - `frontend/src/hooks/useWorkspaceSessions.ts`
  - `frontend/src/hooks/useKanbanProjectSessions.ts`
  - project view replacement for `frontend/src/pages/ProjectTasks.tsx`

## Verification Commands

- `pnpm run generate-types`
- `pnpm run check`
- `pnpm run backend:check`
- `cargo test -p db session_only_migration_backfills_seed_intent -- --exact`
- `cargo test -p db session_only_migration_rehomes_images -- --exact`
- `cargo test -p vibe-ultra create_session_and_start_new_workspace -- --exact`
- `cargo test -p vibe-ultra create_session_and_start_existing_workspace -- --exact`
- `cargo test -p vibe-ultra project_session_stream_orders_snapshot_before_patches -- --exact`
- `cargo test -p vibe-ultra delete_session_preserves_nonempty_workspace -- --exact`
- `cargo test -p vibe-ultra delete_workspace_blocks_on_running_process -- --exact`
- `cargo test -p vibe-ultra delete_workspace_cleans_owned_worktree -- --exact`
- `cd frontend && pnpm vitest run src/hooks/useWorkspaceSessions.session-only.test.ts src/hooks/useKanbanProjectSessions.session-only.test.ts src/pages/ProjectSessions.test.tsx src/components/kanban/session-hub/SessionDeletion.session-only.test.tsx`
- `rg -n --glob '!frontend/dist/**' --glob '!target/**' 'workspace\\.task_id|session\\.task_id|subscribe_tasks_stream|stream_tasks_raw|useProjectTasks|create_task_and_start|get_tasks\\b|get_task\\b|delete_task\\b|update_task\\b' .`

## Exit Criteria

- All touched compile targets pass.
- Targeted migration/create-session tests pass.
- Project UI can create and switch sessions without task-layer APIs.
- No edited runtime path reads `workspace.task_id`, `session.task_id`, or project task streams.
- Deletion and archive behavior are covered by targeted checks.
