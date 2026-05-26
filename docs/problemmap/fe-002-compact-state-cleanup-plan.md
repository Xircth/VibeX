# FE-002 Compact State Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerCompact.ts`.

## Smell

- Boundary violation: compact-in-progress state is derived inline in the component while related compact process detection already lives in the compact helper.
- Missing test: pending compact process id and running compact process state are not directly locked as a combined state.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: context is compacting when either a pending compact process id exists or a compact process is currently running.

## Cleanup Pass

1. Extract pure compacting-state derivation.
2. Keep timer clearing and React state mutation in the component.
3. Preserve the current boolean behavior exactly.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerCompact.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
