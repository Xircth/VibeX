# FE-002 Topbar Visibility Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerSession.ts`.

## Smell

- Boundary violation: composer topbar visibility is derived inline in JSX from token usage, goal state, session selector availability, and executor profile.
- Missing test: session selector visibility should only contribute when it is enabled and sessions exist.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: the topbar is shown when token usage exists, goal state exists, the visible session selector has sessions, or an executor profile exists.

## Cleanup Pass

1. Extract pure topbar visibility derivation.
2. Keep all topbar rendering in the component.
3. Preserve the existing visibility inputs exactly.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerSession.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
