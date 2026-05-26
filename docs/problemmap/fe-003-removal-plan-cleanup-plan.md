# FE-003 Removal Plan Cleanup Plan

## Scope

- Extract displayed-process removal planning from `useConversationHistory`.
- Preserve the guard that skips removal while execution processes are still loading or errored.
- Keep mutable displayed-state deletion, previous-status cleanup, loading/streaming set cleanup, active stream controller closure, and emit behavior in the hook.

## Behavior Locks

- Add direct helper tests for loading/error suppression, removed-id detection, and no-op unchanged process sets.
- Keep the existing hook regression suite green.

## Cleanup Steps

1. Add a failing helper test for the missing removal-plan module.
2. Implement the pure removal planner.
3. Replace hook-local removal id derivation with the planner.
4. Run the helper test, existing hook test, hook-directory tests, frontend check/lint, project check/lint, and `git diff --check`.
