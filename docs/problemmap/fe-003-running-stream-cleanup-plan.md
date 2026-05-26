# FE-003 Running Stream Cleanup Plan

## Scope

- Extract running execution-process stream orchestration from `useConversationHistory`.
- Preserve normalized/raw stream selection, stream id creation, initial baseline replay, stale running snapshot suppression, empty running stream retry, active controller registration/cleanup, finish emit, and error rejection.
- Keep hook-owned displayed-state mutation and entry emission as callbacks.

## Behavior Locks

- Add direct helper tests for initial baseline forwarding, keyed entry emission, stale snapshot suppression, empty running finish retry, and non-retryable error rejection/warning.
- Keep the existing hook regression suite green.

## Cleanup Steps

1. Add a failing helper test for the missing running-stream module.
2. Implement the helper with explicit callbacks for hook-owned state and controller refs.
3. Replace the hook-local `loadRunningAndEmit` implementation with the helper.
4. Run the helper test, existing hook test, hook-directory tests, frontend check/lint, project check/lint, and `git diff --check`.
