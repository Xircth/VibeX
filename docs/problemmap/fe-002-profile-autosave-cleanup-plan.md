# FE-002 Profile Autosave Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerDraft.ts`.

## Smell

- Boundary violation: executor-profile autosave state transition is embedded inside a React effect.
- Missing test: key change detection, loading suppression, and null-profile behavior are not directly locked.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: a changed profile advances the previous-key snapshot even while scratch is loading; autosave happens only when the key changed and scratch is not loading.

## Cleanup Pass

1. Extract pure executor-profile autosave decision logic.
2. Keep `saveToScratch` in the component as the side-effect boundary.
3. Reuse the existing executor profile key function.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerDraft.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
