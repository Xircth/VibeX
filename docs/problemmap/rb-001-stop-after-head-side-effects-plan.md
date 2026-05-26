# RB-001 Stop After-Head Side Effects Plan

Scope: `crates/local-deployment/src/container.rs` stop completion cleanup.

## Smell

`LocalContainerService::stop_execution` records repository `after_head_commit`
only on the in-memory child-handle path. The missing-child path still persists
completion, finishes message stores, and updates task status, but returns before
capturing stopped workspace HEAD state.

## Behavior Lock

Add a service-level no-child stop test that creates a real git repository,
creates an execution repo-state row, stops the process, and verifies
`after_head_commit` is persisted to the current HEAD.

## Cleanup

1. Keep process status persistence and child termination ordering unchanged.
2. Group common stop-finish side effects behind one local helper.
3. Make both child and no-child stop paths run message-store/DB-stream cleanup,
   task status policy, and best-effort after-head capture.

## Verification

- New targeted no-child after-head test.
- Existing no-child stop cleanup and dev-server status tests.
- `container::tests`, `process_completion`, local-deployment check, format,
  repo checks.
