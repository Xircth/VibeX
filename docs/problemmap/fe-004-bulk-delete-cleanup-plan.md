# FE-004 Bulk Delete Derivation Cleanup Plan

## Scope

- `frontend/src/components/kanban/KanbanSessionHub.tsx`
- `frontend/src/components/kanban/session-hub/utils.ts`
- `frontend/src/components/kanban/session-hub/utils.test.ts`

## Smell

`handleDeleteSelectedSessions` mixes UI orchestration, API side effects, cache invalidation, and pure result derivation. The pure parts are currently embedded in the callback:

- deriving succeeded delete ids from `Promise.allSettled`
- pairing failed results with the original selected session id
- deriving affected workspace ids from selected session records
- deriving the remaining session id set after successful deletes

That makes the delete flow harder to test without a mounted Hub and increases the risk that future UI changes alter data-handling behavior.

## Behavior Lock

Add focused helper tests for bulk delete result derivation before changing the Hub:

- mixed fulfilled/rejected results preserve failed session ids and omit missing records from affected workspace ids
- affected workspace ids are deduped
- remaining session ids exclude only successful deletes
- all-success results produce no failed session ids

## Cleanup Pass

1. Add a pure `getBulkDeleteSessionSummary` helper in `session-hub/utils.ts`.
2. Replace the inline derivation in `KanbanSessionHub.tsx` with the helper.
3. Keep delete API calls, cache invalidation, error message mapping, and UI state updates in the Hub for this pass.

## Verification

- `pnpm vitest run src/components/kanban/session-hub/utils.test.ts`
- `pnpm vitest run src/components/kanban`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
