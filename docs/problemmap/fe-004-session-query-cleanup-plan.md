# FE-004 Session Query Cleanup Plan

Scope: `frontend/src/components/kanban/KanbanSessionConversationView.tsx` and a focused Kanban session query helper.

## Smell

- Weak boundary: the session detail query relies on `sessionId!` even though query enablement is a separate boolean.
- Missing test: no pure coverage proves that a missing session id disables the query and withholds a fetch id.
- Maintainability risk: query key, enabled state, and fetch input can drift.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing query key shape: `['session', sessionId]`.
- Preserve existing behavior: no session id disables session-detail fetches; a present session id enables them and is the fetch input.

## Cleanup Pass

1. Extract pure session-detail query state derivation.
2. Replace `sessionId!` with the helper's guarded fetch id.
3. Keep existing render/loading behavior unchanged.

## Verification

- `pnpm vitest run src/components/kanban/kanbanSessionConversationQuery.test.ts`
- `pnpm vitest run src/components/kanban/KanbanSessionConversationView.test.tsx`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
