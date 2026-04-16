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
- `crates/db/src/models/workspace.rs`
- `crates/db/src/models/session.rs`
- `crates/db/src/models/execution_process.rs`
- `crates/db/src/models/image.rs`
- `crates/db/src/models/scratch.rs`

Changes:

- add `workspaces.project_id`
- add `workspaces.parent_workspace_id`
- add `sessions.initial_prompt`
- define `sessions.initial_prompt` as immutable seed intent; `sessions.name` remains editable display metadata
- rehome task-linked image relationships to deterministic workspace ownership
- remove runtime reliance on `DraftTask`
- backfill:
  - `workspaces.project_id` from `tasks.project_id`
  - `workspaces.parent_workspace_id` from current task-parent relationship
  - `sessions.initial_prompt` from seed `task.description`
- keep legacy task reads temporarily available during the backfill phase only

### Legacy Data Migration Policy

- If a legacy session already has a first user prompt in `coding_agent_turns`, that prompt becomes `sessions.initial_prompt`.
- If a legacy session has no first user prompt:
  - if it is the earliest-created session in the legacy workspace, backfill `sessions.initial_prompt` from the legacy `task.description`
  - otherwise leave `sessions.initial_prompt` null and report it as a promptless secondary session
- If a legacy workspace has no session, create one synthetic seed session with:
  - `name = legacy task.title`
  - `initial_prompt = legacy task.description`
  - `status = mapped legacy task.status`
  - `executor = latest known workspace/session executor when available`
- If a legacy task has no workspace and no session, discard it during migration and report it explicitly as a dropped backlog-only row.
- Migration logs must report counts for:
  - prompt-backed sessions
  - task-description fallback sessions
  - synthetic seed sessions created
  - promptless secondary sessions left null
  - discarded task-only rows

### Legacy Image Migration Policy

- Introduce `workspace_images` for shared workspace execution-context assets.
- Migrate each legacy `task_images(task_id, image_id)` row to every associated workspace that descended from that task:
  - seed workspaces where `workspaces.task_id = task_id`
  - reused workspaces that contain `sessions.task_id = task_id`
- Deduplicate on `(workspace_id, image_id)`.
- Do not backfill legacy task images into session-scoped ownership; legacy task images represented shared work-context, not per-session conversation state.
- New per-session uploads after the cutover use session-scoped ownership only when the asset is created from inside an existing workspace session.

### Step 2: Phase C backend create/start and execution-context rewrite

Touchpoints:

- `src-tauri/src/commands/sessions.rs`
- `src-tauri/src/commands/workspaces.rs`
- `src-tauri/src/commands/tasks.rs`
- `crates/services/src/services/container.rs`
- `crates/db/src/models/workspace_repo.rs`

Changes:

- introduce a unified `create_session_and_start`
- request contract:
  - `existing_workspace_id + session_spec`
  - `workspace_spec + session_spec`
- `workspace_spec` owns:
  - `project_id`
  - repo mapping
  - target branches
  - `use_worktree`
  - branch strategy
  - optional workspace name
- `session_spec` owns:
  - `name`
  - `initial_prompt`
  - executor
  - optional session-scoped attachments
- lift workspace resolution logic out of `create_task_and_start`
- resolve initial prompt from `session.initial_prompt`
- rewrite execution context to load project from `workspace.project_id`
- delete task-first start commands only after all new callers are migrated

### Step 3: Phase C/D project stream, query, and route rewrite

Touchpoints:

- `crates/services/src/services/events/streams.rs`
- `src-tauri/src/commands/events.rs`
- `src-tauri/src/lib.rs`
- `frontend/src/lib/api/{sessions,attempts,tasks}.ts`
- `frontend/src/hooks/{useProjectTasks,useWorkspaceSessions,useKanbanProjectSessions}.ts`
- `frontend/src/pages/ProjectTasks.tsx`
- `frontend/src/App.tsx`

Changes:

- replace task stream with a first-class project session/workspace stream whose snapshot and patches are keyed by `workspace_id` / `session_id`
- remove task API surface from command registration and TS bindings
- replace task routes with project session/workspace routes
- make project kanban/list render sessions or workspaces directly
- do not rely on stitched frontend queries as the permanent project view source

### Step 4: Phase C/D hierarchy, asset, and lifecycle rewrite

Touchpoints:

- `crates/db/src/models/workspace.rs`
- `src-tauri/src/commands/workspaces.rs`
- `frontend/src/components/dialogs/tasks/ViewRelatedTasksDialog.tsx`
- `frontend/src/components/panels/TaskPanel.tsx`

Changes:

- move subtask relationship semantics to workspace lineage
- replace task-detail related-task UI with workspace/session relationship UI
- restore image association behavior on the new owner entity
- define deletion and archive ownership:
  - session deletion removes session history, session scratch, session assets
  - workspace deletion blocks on running non-dev execution, child lineage policy, and owned worktree cleanup
  - archive remains workspace-scoped; todo/inprogress/inreview/done remain session-scoped

### Step 5: Phase E/F type generation and cleanup

Touchpoints:

- `src-tauri/src/bin/generate_types.rs`
- `shared/types.ts`
- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/lib.rs`
- frontend imports of task types

Changes:

- remove task declarations from generated runtime types
- drop task commands from exports
- delete dead task hooks/components/routes after replacement
- only remove `tasks` table and final read paths after workspace/session sources are the sole runtime source of truth

## Risks and Mitigations

- Risk: migration leaves old DBs unreadable
  - Mitigation: add explicit migration order and targeted migration validation on a copied dev DB
- Risk: compile failures explode because task types are pervasive
  - Mitigation: cut ownership chain first, then delete commands/types only after replacement queries compile
- Risk: project views go blank during stream rewrite
  - Mitigation: keep a query-backed fallback while replacing the task stream
- Risk: session start loses the initial prompt on fresh workspaces
  - Mitigation: add direct tests around `create_session_and_start` and first execution path
- Risk: session becomes the new overloaded god object
  - Mitigation: keep workspace spec separate from session spec and keep `initial_prompt` immutable
- Risk: destructive cleanup semantics regress after task deletion
  - Mitigation: define and test session deletion vs workspace deletion separately before removing task cleanup code

## Expanded Test Plan

### Unit

- workspace matching for non-worktree reuse
- session display-name fallback without task title
- session initial prompt selection
- workspace lineage parent/child lookup

### Integration

- migration from task-backed schema to session-only schema
- create session with new worktree workspace
- create session with reused non-worktree workspace
- create additional session inside existing workspace
- session deletion and workspace deletion policy checks
- legacy no-session workspace creates synthetic seed session
- legacy task-only row discard is counted and logged
- legacy task images become deduped `workspace_images` across all associated workspaces

### E2E

- project-level create session -> execution starts -> session appears in project view
- existing workspace -> new session -> send follow-up -> logs isolated by session
- parent workspace -> child workspace creation and navigation
- project stream updates correctly without task events
- concurrent workspace/session updates preserve snapshot-before-patch ordering in project UI

### Observability

- session/workspace create logs contain workspace id + session id + project id
- stream payloads identify project/workspace/session without task ids
- migration logs clearly report counts of migrated workspaces/sessions/images

## Verification Steps

1. Run migration and create-flow backend tests:
   - `cargo test -p db session_only_migration_backfills_seed_intent -- --exact`
   - `cargo test -p db session_only_migration_rehomes_images -- --exact`
   - `cargo test -p vibe-ultra create_session_and_start_new_workspace -- --exact`
   - `cargo test -p vibe-ultra create_session_and_start_existing_workspace -- --exact`
   - `cargo test -p vibe-ultra project_session_stream_orders_snapshot_before_patches -- --exact`
   - `cargo test -p vibe-ultra delete_session_preserves_nonempty_workspace -- --exact`
   - `cargo test -p vibe-ultra delete_workspace_blocks_on_running_process -- --exact`
   - `cargo test -p vibe-ultra delete_workspace_cleans_owned_worktree -- --exact`
2. Run `pnpm run generate-types`.
3. Run `pnpm run check`.
4. Run `pnpm run backend:check`.
5. Run targeted frontend tests:
   - `cd frontend && pnpm vitest run src/hooks/useWorkspaceSessions.session-only.test.ts src/hooks/useKanbanProjectSessions.session-only.test.ts src/pages/ProjectSessions.test.tsx src/components/kanban/session-hub/SessionDeletion.session-only.test.tsx`
6. Run source-of-truth grep checks:
   - `rg -n --glob '!frontend/dist/**' --glob '!target/**' 'workspace\\.task_id|session\\.task_id|subscribe_tasks_stream|stream_tasks_raw|useProjectTasks|create_task_and_start|get_tasks\\b|get_task\\b|delete_task\\b|update_task\\b' .`
7. Manually verify:
   - create session at project level
   - create session inside existing workspace
   - switch sessions
   - open project view without any task route dependency
   - delete session and confirm workspace survives when expected
   - delete workspace and confirm owned worktree cleanup / lineage behavior

## Available-Agent-Types Roster

- `architect`: model boundaries, migration ordering
- `executor`: schema/API/UI implementation
- `critic`: plan quality and risk review
- `debugger`: migration/runtime failure diagnosis
- `verifier`: validation of completion evidence
- `test-engineer`: focused regression and migration coverage planning

## Follow-up Staffing Guidance

### Ralph lane

- `executor` high: schema + backend command cutover
- `executor` high: frontend route/query/view cutover
- `debugger` high: migration/runtime fallout
- `verifier` high: final acceptance sweep

### Team lane

- Lane 1: schema/models/backend create flow
- Lane 2: streams/routes/type generation
- Lane 3: frontend views/hooks/component cleanup
- Lane 4: migration/test harness/verification

Suggested reasoning:

- schema/backend lanes: `high`
- stream/type lane: `medium`
- frontend cleanup lane: `medium`
- verification lane: `high`

## Team Verification Path

- Team proves migrations apply, project create/session create flows work, and project views render without task APIs.
- Final verifier proves no runtime task dependency remains in the edited path and all targeted checks pass.
