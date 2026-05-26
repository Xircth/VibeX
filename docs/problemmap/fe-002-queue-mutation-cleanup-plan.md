# FE-002 Queue Mutation Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerQueue.ts`.

## Smell

- Weak boundary: queue query key construction and queue/cancel mutation inputs are still owned by the component.
- Historical risk: mutation functions depend on `sessionId!` even though the safe guard lives in separate callbacks.
- Missing test: the no-session queue/cancel boundary is not locked as a pure decision.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: queue and cancel calls are skipped without a session id.
- Preserve existing query-key shape: `['queue-status', sessionId]`.

## Cleanup Pass

1. Extract queue status query-key construction.
2. Extract queue and cancel mutation input construction.
3. Replace component-level non-null assertions with helper-guarded mutation variables.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerQueue.test.ts`
- `pnpm vitest run src/components/tasks/follow-up`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
