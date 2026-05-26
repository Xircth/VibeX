# RB-001 Start Spawn Registration Plan

## Scope

- Files: `crates/local-deployment/src/container.rs`.
- Smell: `LocalContainerService::start_execution_inner` still interleaves executor spawn result handling with runtime registration details: message-store stream setup, child storage, cancellation token storage, and exit-monitor handle storage.

## Behavior Lock

- Extend the script startup service test to assert that a successful start registers:
  - the child process handle,
  - the in-memory message store,
  - the DB stream handle,
  - the exit monitor handle.
- Keep the script action path so the test avoids external coding-agent binaries while exercising the real spawn and registration flow.

## Cleanup Pass

1. Extract spawned child registration into `LocalContainerService::register_spawned_execution`.
2. Keep the 30-second spawn timeout and `ExecutorAction::spawn` call in `start_execution_inner`.
3. Do not change process cancellation, message streaming, or exit monitor semantics.

## Verification

- `cargo test -p local-deployment start_execution_script_stores_db_stream_handle_on_success --lib`
- `cargo test -p local-deployment container::tests --lib`
- Broader gates after the pass: `cargo test -p services container_workflow --lib`, `cargo test -p local-deployment process_completion --lib`, `cargo check -p services -p local-deployment`, `cargo fmt --check`, `pnpm run check`, `pnpm run lint`, `git diff --check`.
