# FE-002 Attempt Refresh Runtime Hook Cleanup Plan

## Scope

- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/useSessionComposerAttemptRefresh.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerAttemptRefresh.test.tsx`
- ProblemMap status and verification ledger

## Behavior Lock

- Branch state is refreshed only when an attempt transitions from running to stopped.
- Both branch status and attempt branch refetch callbacks run on a valid stopped transition.
- Missing workspace suppresses refreshes.
- The previous-running snapshot advances after every render so stale running state does not trigger duplicate refreshes.

## Cleanup Pass

1. Add hook-level behavior tests before editing the component.
2. Extract previous-running state and branch refresh effects into `useSessionComposerAttemptRefresh`.
3. Keep `getAttemptStoppedRefreshDecision` as the pure state-transition boundary.
4. Re-run targeted hook/helper tests, the follow-up directory suite, frontend typecheck/lint, full check/lint, and `git diff --check`.

## Non-goals

- Do not change branch status fetching hooks.
- Do not change attempt running derivation.
- Do not change queue refresh behavior tied to process-count changes.
