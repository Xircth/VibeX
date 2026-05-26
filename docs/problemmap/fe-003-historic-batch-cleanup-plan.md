# FE-003 Historic Batch Cleanup Plan

## Scope

- Extract historic process batch loading from `useConversationHistory`.
- Preserve reverse chronological process loading, concurrency chunking, initial-load stop after the minimum entry threshold, remaining-load skip for displayed/running processes, and patch-key assignment.
- Keep React effect cancellation, displayed-state mutation, and emits in the hook.

## Behavior Locks

- Add direct helper tests for patch-key conversion, initial chunk stop behavior, remaining-process filtering, and remaining batch continuation decisions.
- Keep the existing hook regression suite green.

## Cleanup Steps

1. Add a failing helper test for the missing historic batch module.
2. Implement pure-ish batch helpers with the historic entry loader injected for deterministic tests.
3. Replace hook-local initial and remaining batch loading with the helpers.
4. Run the helper test, existing hook test, hook-directory tests, frontend check/lint, project check/lint, and `git diff --check`.
