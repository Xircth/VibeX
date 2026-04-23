# PRD: Session-Only Model Cutover

## Requirements Summary

The product model must be reduced from `Project -> Task -> Workspace -> Session` to `Project -> Workspace -> Session`.

This cutover must:

- remove `task` as a persisted domain layer and UI/API concept
- move project ownership to `workspaces.project_id` instead of indirect ownership via `workspaces.task_id`
- move parent/child hierarchy from `tasks.parent_workspace_id` to `workspaces.parent_workspace_id`
- move first-run prompt ownership from `task.description` to immutable `sessions.initial_prompt`
- keep current workspace creation capabilities when starting work, but keep them owned by workspace creation/resolution rather than by session attributes:
  - repo selection
  - target branch selection
  - `use_worktree`
  - create new branch / new workspace
  - reuse matching non-worktree workspace
- unify project-level creation and in-workspace new-session creation under session APIs

## Evidence Snapshot

- Sessions are already the execution unit with `name`, `status`, `executor`, and optional `task_id`: `crates/db/src/models/session.rs`.
- Project task cards derive activity from `sessions` and `execution_processes`, which means task state is already secondary: `crates/db/src/models/task.rs`.
- Workspace still uses `task_id` as its ownership and context bridge: `crates/db/src/models/workspace.rs`.
- Execution context still resolves task/project via `workspace.task_id`: `crates/db/src/models/execution_process.rs`.
- Current start flow is task-first and only later creates a session: `src-tauri/src/commands/tasks.rs`.
- Project stream and routes are still task-centric: `crates/services/src/services/events/streams.rs`, `src-tauri/src/commands/events.rs`, `frontend/src/hooks/useProjectTasks.ts`, `frontend/src/pages/ProjectTasks.tsx`, `frontend/src/App.tsx`.
- Parent/child relationships are task-backed through `tasks.parent_workspace_id`: `crates/db/src/models/task.rs`.

## RALPLAN-DR Summary

### Principles

1. Keep execution ownership where execution actually happens: session.
2. Keep repo/branch/worktree ownership where git context actually lives: workspace.
3. Remove compatibility layers instead of renaming them.
4. Prefer destructive-but-coherent schema changes over preserving misleading abstractions.
5. Keep create flows converged so project-level and workspace-level session creation use the same backend path.
6. Do not replace one overloaded domain object with another.

### Decision Drivers

1. `task` no longer carries unique operational value; it mostly mirrors session/workspace state.
2. `workspace.task_id` is the main blocker preventing a clean session/workspace model.
3. The new create flow must preserve current repo/branch/worktree behavior without a compatibility wrapper.

### Viable Options

#### Option A: Hard cut to session-only model

- Pros
  - Removes semantic duplication in one pass.
  - Eliminates `task`-based ownership drift.
  - Produces a stable long-term architecture.
- Cons
  - Requires schema migration, route migration, API migration, and stream migration together.
  - Breaks broad swaths of frontend and generated types in one change set.

#### Option B: Keep task as compatibility shell but hide it in UI

- Pros
  - Lower immediate migration risk.
  - Fewer backend breakages in the short term.
- Cons
  - Leaves `workspace.task_id` and task-derived project ownership intact.
  - Preserves the main source of architectural confusion.
  - Makes later removal harder by creating another temporary layer.

#### Option C: Keep tasks as backlog-only records while sessions execute

- Pros
  - Preserves a stable planning/intention object separate from runtime session history.
  - Makes a future “planned but not started” surface easier to implement.
- Cons
  - Keeps a second first-class domain identity alive during a cutover whose explicit goal is to remove it.
  - Requires synchronization rules between backlog intent and runtime session/workspace state.
  - Solves a future planning problem by preserving a current runtime ambiguity.

### Chosen Direction

Choose **Option A**.

### Boundary Definitions

- `Project`
  - top-level ownership and grouping
- `Workspace`
  - `project_id`
  - repo set / target branches
  - `use_worktree`
  - container path / branch strategy
  - parent workspace lineage
  - archive and cleanup boundary
- `Session`
  - immutable `initial_prompt`
  - editable `name`
  - status / executor
  - conversation and execution history
  - session-scoped assets

### Invalidation Rationale

- Reject UI-only renaming because it leaves the same backend ownership problems intact.
- Reject compatibility-shell task retention because the user explicitly wants the aggressive direction and this path preserves the most misleading dependencies.
- Reject backlog-only task retention for this cutover because it intentionally preserves a second identity model before the runtime ownership chain has been simplified; if backlog semantics are needed later, they should return as a new explicit planning entity, not as leftover runtime state.

## Deliberate-Mode Pre-Mortem

1. Migration removes `task_id` links before all execution-context call sites are updated, causing runtime failures when starting or restoring sessions.
2. Project-level lists/streams still query task-backed records, causing empty project views after schema cutover.
3. Parent-child relationships and image attachments silently disappear because they were task-backed and were not rehomed before task deletion.

## ADR

### Decision

Adopt a session-only domain model with direct `Project -> Workspace -> Session` ownership and remove the task layer entirely.

### Drivers

- Sessions already own execution behavior.
- Workspaces already own repo/branch/worktree behavior.
- Task adds indirection without adding unique runtime semantics.

### Alternatives Considered

- Hide task in UI but retain storage/API compatibility.
- Keep tasks as backlog-only records while sessions execute.

### Why Chosen

The hard cut is the only option that removes the broken ownership chain and prevents future code from reintroducing task-first assumptions.

### Consequences

- Broad compile breakage is expected during the cutover.
- Existing routes, streams, generated types, and tests must be updated in lockstep.
- Legacy task data becomes a migration concern instead of a runtime concern.

### Follow-ups

- Add a one-time migration strategy for existing databases and fixture data.
- Rewrite project-level views around sessions/workspaces.
- Revisit whether hierarchy belongs on `workspaces.parent_workspace_id` alone or also needs session-level lineage later.
- Revisit whether `goal_kind` or another stable intent tag is needed after the cutover settles.

## Acceptance Criteria

1. No backend command required for normal execution or listing references `Task`, `tasks` table records, or `task_id` for workspace/session ownership.
2. `workspaces` owns `project_id` directly and can be queried by project without joining through `tasks`.
3. Project-level session creation supports:
   - new workspace with worktree
   - new workspace without worktree
   - reuse of matching non-worktree workspace
   - repo selection and target branch mapping
4. In-workspace new-session creation and project-level new-session creation converge on a shared backend create/start path.
5. Initial prompt for first execution comes from session data, not task data.
6. Session summaries and project views render without task-derived titles/status.
7. Parent-child relationships continue to work through workspace lineage.
8. Shared types no longer export task types used by runtime session/workspace flows.
9. Project live data is delivered by a first-class project session/workspace stream instead of a task stream.
10. Deletion semantics are explicit:
   - deleting a session never deletes a non-empty workspace implicitly
   - deleting a workspace enforces no running non-dev process and handles child lineage and owned worktree cleanup

## Implementation Steps

### Step 1: Phase A/B schema expansion and backfill

Touchpoints:

- `crates/db/migrations/*.sql`
- `crates/db/src/models/work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   