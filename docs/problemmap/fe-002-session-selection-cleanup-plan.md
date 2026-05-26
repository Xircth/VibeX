# FE-002 Session Selection Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerSession.ts`.

## Smell

- Boundary violation: session selection notification policy is embedded inside the UI callback that also performs local selection.
- Missing test: parent notification suppression when no workspace id exists is not directly locked.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: always select the local session, but notify the parent only when a workspace id is available.

## Cleanup Pass

1. Extract pure selected-session notification payload derivation.
2. Keep `selectSession` and `onSessionSelected` calls in the component as side effects.
3. Avoid changing session id or workspace id source priority.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerSession.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
