# FE-002 Scratch Target Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerSession.ts`.

## Smell

- Boundary violation: draft scratch target selection is derived inline in the component even though it is a session/workspace policy.
- Missing test: new-session drafts using the workspace id and existing-session drafts using the session id are not directly locked.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: new-session mode stores draft state under the workspace id; existing-session mode stores it under the active session id.

## Cleanup Pass

1. Extract pure scratch target id derivation.
2. Keep scratch hook usage and persistence side effects in the component.
3. Preserve `undefined` fallback for missing ids.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerSession.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
