# FE-002 Session Rename Invalidation Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerSession.ts`.

## Smell

- Boundary violation: query invalidation policy for renamed sessions is embedded inside the UI callback that also calls the rename API.
- Missing test: workspace-session invalidation suppression when no workspace id exists is not directly locked.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: invalidate the workspace session list only when a workspace exists, and always invalidate the renamed session query.

## Cleanup Pass

1. Extract pure rename-session invalidation derivation.
2. Keep `sessionsApi.rename` and React Query invalidation calls in the component.
3. Preserve the existing invalidation key shapes.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerSession.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
