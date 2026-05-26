# FE-002 Compact Runtime Hook Cleanup Plan

## Scope

- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/useSessionComposerContextCompact.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerContextCompact.test.tsx`
- ProblemMap status and verification ledger

## Behavior Lock

- Compact requests are suppressed when the compact turn input cannot be built.
- Valid compact requests clear the current follow-up error, clear stopping state, send `/compact` through the provider runtime, and mark the returned execution process id as pending.
- Pending compact state clears when the returned process appears in the process list.
- Pending compact state clears after the existing timeout window when no process appears.
- Provider runtime failures map to the existing compact error message.

## Cleanup Pass

1. Add hook-level tests for compact runtime orchestration before editing the component.
2. Extract compact runtime state/effects and `sendProviderRuntimeTurn` execution into `useSessionComposerContextCompact`.
3. Keep the pure compact helper boundary unchanged.
4. Re-run targeted hook/helper tests, the follow-up directory suite, frontend typecheck/lint, full check/lint, and `git diff --check`.

## Non-goals

- Do not change compact eligibility rules.
- Do not change the `/compact` prompt contract.
- Do not change process-list loading or conversation-history compaction behavior.
