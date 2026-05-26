# RB-001 Start Success Log Stream Plan

## Scope

- Files: `crates/services/src/services/container.rs`, `crates/local-deployment/src/container.rs`.
- Smell: `start_execution` still owns success-path log normalization selection and DB stream setup after executor spawn succeeds.

## Behavior Lock

- Add a local service test that starts a long-running script action through `start_execution`.
- Assert successful startup creates an execution process, an in-memory message store, and a DB stream handle before the test stops the process for cleanup.
- Use a script action to avoid depending on an external coding-agent binary or profile.

## Cleanup Pass

1. Extract success-path log normalization and DB stream setup into `start_success_log_streaming`.
2. Keep normalization target selection in `container_workflow::log_normalization_target`.
3. Do not change executor spawning, child tracking, exit monitor setup, failed-start cleanup, or stop cleanup.

## Verification

- `cargo test -p local-deployment start_execution_script_stores_db_stream_handle_on_success --lib`
- `cargo test -p services container_workflow --lib`
- `cargo test -p local-deployment container::tests --lib`
- Broader gates after the pass: `cargo check -p services -p local-deployment`, `cargo fmt --check`, `pnpm run check`, `pnpm run lint`, `git diff --check`.
