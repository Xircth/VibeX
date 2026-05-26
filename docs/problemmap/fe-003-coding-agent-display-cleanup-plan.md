# FE-003 Coding Agent Display Cleanup Plan

## Scope

- Extract the coding-agent/review display construction from `useConversationHistory`.
- Preserve user-message synthesis, token/user entry filtering, assistant replay-prefix stripping, pending-approval detection, loading entry insertion, and setup-required detection.
- Keep stream loading, historic loading, queue display, and next-action aggregation in the hook for later passes.

## Behavior Locks

- Add direct helper tests for non-agent suppression, synthetic user prompt insertion, user/token filtering, assistant replay-prefix stripping, pending-approval loading suppression, running loading insertion, failed setup-required detection, and context compact delegation.
- Keep the existing hook regression tests green.

## Cleanup Steps

1. Add a failing helper test for the missing coding-agent display module.
2. Implement the pure helper with explicit inputs for live process status, previous assistant transcript, and process state.
3. Replace the inline coding-agent branch in `flattenEntriesForEmit` with the helper and keep flag aggregation in the hook.
4. Run the helper test, existing hook test, hook-directory tests, frontend check/lint, project check/lint, and `git diff --check`.
