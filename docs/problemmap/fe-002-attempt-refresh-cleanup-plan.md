# FE-002 Attempt Refresh Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and a new focused helper under `frontend/src/components/tasks/follow-up/`.

## Smell

- Boundary violation: attempt-running transition policy is embedded inside a React effect that also performs branch-status side effects.
- Missing test: the edge cases for stopped attempts, still-running attempts, and missing workspaces are not directly locked.

## Behavior Lock

- Add a focused helper test before editing the component.
- Cover the exact refresh rule: refresh branch state only when the previous snapshot was running, the current value is stopped, and a workspace exists.
- Cover snapshot progression so the effect continues to update its previous-running ref every render.

## Cleanup Pass

1. Extract pure attempt-refresh decision logic.
2. Keep the effect as the side-effect owner; it should call refresh APIs only after the pure helper says to refresh.
3. Avoid new dependencies and avoid changing branch-query behavior.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerAttempt.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
