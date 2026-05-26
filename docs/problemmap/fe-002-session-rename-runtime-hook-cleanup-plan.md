# FE-002 Session Rename Runtime Hook Cleanup Plan

## Scope

- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/useSessionComposerSessionRename.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerSessionRename.test.tsx`
- ProblemMap status and verification ledger

## Behavior Lock

- Renaming calls `sessionsApi.rename` with the target session id and nullable name.
- Workspace session-list invalidation runs only when a workspace id is available.
- The renamed session query is invalidated for every successful rename.
- Rename failures do not invalidate cached queries.

## Cleanup Pass

1. Add hook-level behavior tests before editing the component.
2. Extract rename API execution and invalidation sequencing into `useSessionComposerSessionRename`.
3. Keep `getSessionRenameInvalidation` as the pure key boundary.
4. Re-run targeted hook/helper tests, the follow-up directory suite, frontend typecheck/lint, full check/lint, and `git diff --check`.

## Non-goals

- Do not change session label derivation.
- Do not change session selection or created-session profile memory handling.
- Do not change the existing nullable session-name contract.
