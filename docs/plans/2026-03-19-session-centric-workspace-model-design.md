---
title: "Session-Centric Workspace Model Design"
description: "Redefine task, workspace, and session so Kanban and session lists use session as the primary unit."
---

# Session-Centric Workspace Model Design

## Goal

Unify the local project model around `session` instead of `task` or `workspace`.

After this change:

- `task` is the entry used to create a new session
- `workspace` is the execution container for one branch context
- `session` is the primary UI and business unit
- Kanban cards and session list items both represent sessions

## Confirmed Rules

### Core concepts

- A task is "create one new session with a title and description"
- A workspace represents one branch context and may contain multiple sessions
- The first task created for a workspace provides the default workspace name
- Later tasks created in the same workspace only create new sessions
- Session names are independent and may diverge from the workspace name

### Session status

- Session status is unified to four states:
  - `todo`
  - `inprogress`
  - `inreview`
  - `done`
- Old `cancelled` is folded into `done`

### Workspace reuse

- If `use_worktree = true`, always create a new workspace
- If `use_worktree = false`, reuse an existing workspace only when all repo target branches match
- For multi-repo projects, reuse requires an exact `repo_id -> target_branch` mapping match

### Rename rules

- Session rename is allowed only in:
  - the execution area session selector
  - the session list item itself
- Kanban cards do not allow rename

## Target Data Model

### Session

Current `Session` is too thin. It must become the first-class unit.

Add these fields:

- `name: string | null`
- `status: SessionStatus`
- `task_id: string | null`
- optional: `name_source: 'task_title' | 'first_prompt' | 'manual'`

Display name rules:

- If a manual name exists, use it
- Else if created from a task, use the task title
- Else if first prompt exists, derive a default name from it
- Else use `New Session`

### Workspace

Keep `workspace.name` and `workspace.branch`.

Behavior changes:

- `workspace.name` defaults to the first task title that created the workspace
- user manual rename always wins
- `workspace.task_id` should stop being treated as the current owner task in frontend logic
- short-term compatibility is acceptable if `workspace.task_id` remains as the seed task reference

### Task

Task remains as a creation entry and compatibility object, but not as the primary unit of Kanban.

Task creation should produce:

- a new session
- optionally a new workspace
- a session title sourced from task title

## Backend Changes

### Database and shared types

Update generated shared types and backend models for:

- `Session`
- session summary payload
- session status enum

Likely touchpoints:

- `crates/db/src/models/session.rs`
- `shared/types.ts`
- generated type source used by the type generator

### Session summary API

Current frontend derives too much from `first_prompt` and `workspace.task_id`.

`get_session_summaries` should return enough information for direct rendering:

- `id`
- `workspace_id`
- `executor`
- `created_at`
- `updated_at`
- `first_prompt`
- `is_running`
- `display_name`
- `status`
- `workspace_name`
- `workspace_branch`
- `task_id`

### Task creation and start flow

`create_task_and_start` must be changed to:

1. create the task record
2. resolve workspace by `use_worktree` and repo-branch mapping
3. create a session in that workspace
4. set session name from task title
5. if workspace is new and has no name, set workspace name from task title
6. start execution against that session

This is the key correction. The old assumption "one task owns one workspace" must be removed.

### New session flows

Creating a session from execution area or session list should support:

- optional explicit name
- default unresolved name if user skips editing
- later rename via dedicated API

Add API endpoints or commands for:

- `create_session` with optional `name`
- `rename_session`
- `update_session_status`

## Frontend Changes

### Session list and execution area

Move session UI to consume backend session names and statuses directly.

Primary files:

- `frontend/src/hooks/useWorkspaceSessions.ts`
- `frontend/src/components/tasks/follow-up/SessionSelector.tsx`
- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/lib/api/sessions.ts`

Required behavior:

- new execution-area session starts in editable name mode
- session-list create flow adds optional name input
- hover rename in execution area
- click-to-edit rename in session list
- four session statuses shown consistently

### Kanban

Kanban already renders sessions, but still depends on task-derived fields.

Primary files:

- `frontend/src/hooks/useKanbanProjectSessions.ts`
- `frontend/src/components/kanban/KanbanSessionHub.tsx`

Required behavior:

- card unit is session only
- columns are grouped by `session.status`
- card content aligns with session list item content
- click action still opens monitor area
- rename is not available in Kanban

### Card content parity

Kanban card and session list item should show the same information model:

- session name
- session status
- workspace name
- branch
- executor
- updated time

Difference:

- session list click opens workspace
- Kanban click opens monitor area

## Migration Strategy

### Phase 1: Backend model expansion

- add session name and status
- expand session summary response
- add session rename support
- keep old workspace-task compatibility temporarily

### Phase 2: Workspace reuse logic

- update `create_task_and_start`
- implement exact multi-repo branch matching
- ensure non-worktree tasks can create sessions in an existing workspace

### Phase 3: Session UI unification

- execution area selector rename
- session list create and rename
- session status rendering

### Phase 4: Kanban switch-over

- remove task-derived status/title logic from Kanban session records
- group and display by session status only

### Phase 5: Cleanup

- reduce frontend dependence on `workspace.task_id`
- audit all places where task is used as current workspace owner

## Acceptance Criteria

- Non-worktree task creation reuses an existing workspace only when repo-branch mapping fully matches
- Multiple tasks may produce multiple sessions under one workspace
- Workspace name defaults to the first task title and does not get overwritten by later tasks
- Session list and Kanban use the same session identity and status model
- Execution area and session list can rename sessions
- Kanban cannot rename sessions
- `cancelled` no longer appears as a distinct session state

## Implementation Breakdown

### Step 1: Extend backend session model

Add persistent session fields before touching frontend behavior.

Target files:

- `crates/db/src/models/session.rs`
- session-related SQL migrations in the db crate
- shared type generator source

Required work:

- add `name`
- add `status`
- add `task_id`
- add model update methods for rename and status update
- keep existing reads compatible with old rows by backfilling defaults

Default migration rules:

- `name = null`
- `status = 'todo'` for existing sessions unless a better mapping is available
- `task_id = null`

### Step 2: Expand session summaries

Make session summaries fully renderable so frontend stops guessing.

Target files:

- backend command for `get_session_summaries`
- `frontend/src/lib/api/base.ts`
- `frontend/src/lib/api/sessions.ts`

Summary payload should include:

- session identity fields
- session status
- resolved display name
- workspace name
- workspace branch
- optional source task id

Display name should be resolved in backend, not recomputed in multiple frontend hooks.

### Step 3: Correct task creation semantics

Rework `create_task_and_start` so task creates a session, not necessarily a new workspace.

Target files:

- task creation command and service layer
- workspace lookup logic
- task mutation payload handling

Required flow:

1. create task
2. if `use_worktree=true`, create workspace
3. else find reusable workspace by exact repo-branch mapping
4. create session inside resolved workspace
5. assign session name from task title
6. if workspace is new and unnamed, assign workspace name from task title
7. start execution on the created session

This step is the highest-risk logic change and should be isolated from UI changes.

### Step 4: Support named session creation

Both manual new-session entry points need optional naming support.

Target files:

- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/SessionSelector.tsx`
- `frontend/src/components/kanban/KanbanSessionHub.tsx`
- backend `create_session` command

Behavior:

- task-created session always uses task title
- execution-area new session opens in edit mode with a suggested default name
- session-list new session has an optional name field
- blank input falls back to default generated name

### Step 5: Add session rename flows

Rename must exist only in the two approved places.

Target files:

- session rename backend command
- `frontend/src/hooks/useWorkspaceSessions.ts`
- `frontend/src/components/tasks/follow-up/SessionSelector.tsx`
- session list item component in `KanbanSessionHub`

Behavior:

- execution-area session selector shows hover edit control
- session list item supports click-to-edit name
- Kanban cards stay read-only
- optimistic rename is acceptable if query invalidation is reliable

### Step 6: Unify session status rendering

All session surfaces must render the same four statuses.

Target files:

- `frontend/src/hooks/useWorkspaceSessions.ts`
- `frontend/src/hooks/useKanbanProjectSessions.ts`
- `frontend/src/components/tasks/follow-up/SessionSelector.tsx`
- `frontend/src/components/kanban/KanbanSessionHub.tsx`

Rules:

- `todo`: created but not yet started
- `inprogress`: currently executing or explicitly moved to active execution
- `inreview`: execution finished and waiting for follow-up/review
- `done`: completed or cancelled

Do not keep separate frontend-only labels derived from queue/running state as the primary status.
Queue and running can still appear as secondary badges.

### Step 7: Convert Kanban records to session-first

Current Kanban data already iterates sessions, but task-derived fields still leak in.

Target files:

- `frontend/src/hooks/useKanbanProjectSessions.ts`
- `frontend/src/components/kanban/KanbanSessionHub.tsx`

Required cleanup:

- remove `taskStatus` as the canonical column source
- remove `taskTitle` as the canonical subtitle source
- use `session.status` for grouping
- use `session.display_name` as the main title
- use `workspace.name + branch` as the ownership line

### Step 8: Audit task-centric assumptions

Several places still assume `workspace.task_id` is the current owner task.

Audit likely includes:

- task detail routing after create-and-start
- attempt/workspace panel selection
- task status updates triggered by execution completion
- relationships and subtask logic that rely on parent workspace

Short-term compatibility is acceptable, but these assumptions must be documented and narrowed.

## Validation Plan

### Backend validation

- create task with worktree on: always new workspace
- create task with worktree off and same repo-branch mapping: reuse workspace
- create task with worktree off and different repo-branch mapping: new workspace
- rename session persists and survives reload
- existing sessions without names still render usable display names

### Frontend validation

- execution-area new session can be renamed immediately
- session-list new session can be created with or without explicit name
- Kanban and session list show identical session identity fields
- Kanban columns follow the four session statuses
- rename controls do not appear in Kanban

### Regression validation

- `pnpm run frontend:check`
- `pnpm run backend:check`
- targeted creation flows for single-repo and multi-repo projects
- verify existing workspace rename behavior still wins over default naming
