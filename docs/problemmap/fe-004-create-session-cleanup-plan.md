# FE-004 Create Session Derivation Cleanup Plan

## Scope

- `frontend/src/components/kanban/KanbanSessionHub.tsx`
- `frontend/src/components/kanban/session-hub/utils.ts`
- `frontend/src/components/kanban/session-hub/utils.test.ts`

## Smell

The create-session path mixes pure business decisions with mutation orchestration:

- determining whether the form can submit
- validating project/workspace requirements
- resolving an existing workspace selection into `workspace_id` or `branch`
- trimming optional session names
- choosing whether new-workspace repo inputs are attached

The API call, draft scratch write, cache invalidation, popover reset, and placement side effects should stay in the mutation path for this pass. The decision and payload construction should be pure and directly tested.

## Behavior Lock

Add helper tests before changing the Hub:

- existing-workspace creation requires a project id and workspace value
- existing-workspace creation resolves an existing workspace id without repo inputs
- branch-only existing selection resolves a branch and trims blank names to `null`
- new-workspace creation attaches repo inputs and marks `create_workspace`
- submit enablement requires an executor, no pending mutation, and either a valid existing workspace or fully configured new-workspace repos

## Cleanup Pass

1. Add pure helpers for create-session submit enablement and API payload construction.
2. Replace the inline `canCreateSession` and `sessionsApi.createProject` payload logic in `KanbanSessionHub.tsx`.
3. Keep mutation execution, scratch draft write, cache invalidation, and UI reset behavior unchanged.

## Verification

- `pnpm vitest run src/components/kanban/session-hub/utils.test.ts`
- `pnpm vitest run src/components/kanban`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
