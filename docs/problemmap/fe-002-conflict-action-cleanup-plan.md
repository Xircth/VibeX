# FE-002 Conflict Action Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerConflicts.ts`.

## Smell

- Boundary violation: conflict resolve/abort action gating is derived inline in JSX instead of living with the conflict composer policy.
- Missing test: resolve requires editability while abort does not, and both should be disabled while an attempt is running.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: resolve is enabled when follow-up can send, the attempt is not running, and the composer is editable; abort is enabled when follow-up can send and the attempt is not running.

## Cleanup Pass

1. Extract pure conflict action state derivation.
2. Keep `FollowUpConflictSection` rendering and action callbacks in the component.
3. Preserve existing resolve/abort gates exactly.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerConflicts.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
