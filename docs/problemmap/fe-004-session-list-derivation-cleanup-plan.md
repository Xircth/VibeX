# FE-004 Session List Derivation Cleanup Plan

Scope: `frontend/src/components/kanban/KanbanSessionHub.tsx` and `frontend/src/components/kanban/session-hub/utils.ts`.

## Smell

- Weak boundary: Hub owns list filtering, executor filter options, grouped status sections, and displayed-count derivation before passing all results into Sidebar.
- Duplication risk: Sidebar behavior depends on several separately derived props that must stay in sync.
- Missing tests: filter/display-count/grouping behavior is not locked as pure data logic.

## Behavior Lock

- Add focused helper coverage before editing Hub.
- Preserve existing behavior:
  - workspace filters include only matching workspace ids when any are selected,
  - executor filters use the unassigned sentinel for null executors,
  - grouped sessions are built from all active sessions by status,
  - displayed count uses filtered count only when a workspace filter, executor filter, or sort is active.

## Cleanup Pass

1. Extract executor filter options, session filtering, status grouping, and displayed-count derivation to `session-hub/utils.ts`.
2. Replace Hub inline derivations with tested helpers.
3. Leave mutation and drag/drop behavior untouched.

## Verification

- `pnpm vitest run src/components/kanban/session-hub/utils.test.ts`
- `pnpm vitest run src/components/kanban/session-hub/SessionHubSidebar.test.tsx`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
