# FE-002 Created Session Profile Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerSession.ts`.

## Smell

- Boundary violation: the rule for remembering a newly created session's executor profile is embedded inside a callback that mutates a ref.
- Missing test: null and executor-less profile suppression are not directly locked.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: store the profile only when it has an executor, keyed by the created session id.

## Cleanup Pass

1. Extract pure created-session profile memory derivation.
2. Keep ref mutation in the component as the side-effect boundary.
3. Avoid changing default executor profile source priority.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerSession.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
