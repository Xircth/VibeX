# FE-003 Historic Loader Cleanup Plan

## Scope

- Extract historic execution-process entry loading from `useConversationHistory`.
- Preserve normalized/raw stream selection, running snapshot timeout values, idle settle behavior, max-wait fallback, error fallback to latest entries, and controller cleanup.
- Keep initial batch selection, remaining batch selection, stopped-process reload, late historic reload, and running-stream retry orchestration in the hook.

## Behavior Locks

- Add direct loader tests for normalized coding-agent loads, raw script loads, finished-event resolution, running snapshot idle resolution, and error fallback to the latest entries.
- Keep the existing hook regression suite green after replacing the inline loader.

## Cleanup Steps

1. Add a failing helper test for the missing historic loader module.
2. Move the historic stream promise into a helper with an explicit exported function.
3. Replace hook-local historic loading with the helper.
4. Run the helper test, existing hook test, hook-directory tests, frontend check/lint, project check/lint, and `git diff --check`.
