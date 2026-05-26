# FE-002 Queue Indicator Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerQueue.ts`.

## Smell

- Duplication and boundary violation: queue indicator visibility, message preview, and attachment count are derived in the component render path from the same queue status.
- Missing test: queued messages should only be displayed while an attempt is running, with preview/count suppressed otherwise.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: the queue indicator is visible only for a queued message while an attempt is running; preview and attachment count are hidden otherwise.

## Cleanup Pass

1. Extract pure queue indicator state derivation.
2. Keep queue mutations and React Query cache writes in the component.
3. Preserve existing `MessageQueueIndicator` props.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerQueue.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
