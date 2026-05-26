# FE-003 Reload Plan Cleanup Plan

## Scope

- Extract stopped-process and late-historic reload planning from the `useConversationHistory` status effect.
- Preserve the hook as the owner of mutable refs, active stream controller closure, historic entry loading, displayed-state mutation, and emitting.
- Keep running stream retry orchestration for a later pass.

## Behavior Locks

- Add direct helper tests for stopped displayed processes, non-displayed stopped processes, late historic loads after initial load, already-loading historic suppression, and previous-status tracking.
- Keep the existing hook regression suite green.

## Cleanup Steps

1. Add a failing helper test for the missing reload-plan module.
2. Implement a pure planner over execution processes, displayed ids, previous statuses, loading historic ids, and initial-load state.
3. Replace the inline status-effect branching with the planner while preserving all side effects in the hook.
4. Run the helper test, existing hook test, hook-directory tests, frontend check/lint, project check/lint, and `git diff --check`.
