Task statement
- Remove the task layer entirely and keep only `Project -> Workspace -> Session`.
- Migrate task creation capabilities (repo selection, target branch, `use_worktree`, new branch/new workspace creation) into session creation.

Desired outcome
- No backend or frontend runtime dependency on `tasks`.
- Project-level creation creates or reuses a workspace, then creates/starts a session directly.
- Workspace owns project/repo/branch/worktree context.
- Session owns prompt/name/status/executor/history.

Known facts / evidence
- Session is already the execution unit: `crates/db/src/models/session.rs`, `src-tauri/src/commands/sessions.rs`.
- Current create path is still task-first: `src-tauri/src/commands/tasks.rs` `create_task_and_start`.
- Workspace still derives project ownership through `task_id`: `crates/db/src/models/workspace.rs`.
- Execution context still resolves task/project through `workspace.task_id`: `crates/db/src/models/execution_process.rs`.
- Project kanban and project stream are task-centric: `crates/services/src/services/events/streams.rs`, `src-tauri/src/commands/events.rs`, `frontend/src/hooks/useProjectTasks.ts`, `frontend/src/pages/ProjectTasks.tsx`, `frontend/src/App.tsx`.
- Parent/child relationships currently live on `tasks.parent_workspace_id`: `crates/db/src/models/task.rs`.
- Scratch still exposes `DraftTask`: `crates/db/src/models/scratch.rs`.

Constraints
- User explicitly wants the most aggressive direction and does not need backward-compatible user-facing layering.
- Repo is in a dirty worktree; do not revert unrelated edits.
- No new dependencies.
- Need PRD + test-spec artifacts before substantial implementation per workspace guidance.

Unknowns / open questions
- Whether session images should be attached to `sessions` or `workspaces`.
- Whether parent/child hierarchy should be `workspace -> workspace` only, or also support `session -> session`.
- Whether project-level session list should replace current `/tasks` route or coexist temporarily behind the same route.

Likely codebase touchpoints
- `crates/db/src/models/{session,workspace,task,execution_process,image,scratch}.rs`
- `crates/db/migrations/*.sql`
- `crates/services/src/services/{container,events}/**`
- `src-tauri/src/commands/{sessions,tasks,workspaces,events}.rs`
- `src-tauri/src/bin/generate_types.rs`
- `shared/types.ts`
- `frontend/src/{App.tsx,lib/api/*,hooks/*,pages/ProjectTasks.tsx,components/**}`
