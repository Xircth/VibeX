# RB-001 Start Execution Env Plan

## Scope

- Files: `crates/local-deployment/src/container.rs`.
- Smell: `LocalContainerService::start_execution_inner` still assembles repo context, commit-reminder config, task/project lookups, and `VK_*` environment variables inline with executor spawning and child tracking.

## Behavior Lock

- Extend the script startup service test so the script prints selected `VK_*` variables from the actual child process.
- Assert stdout contains project name, workspace id, and session id before stopping the process.
- Keep the script action path so the test does not depend on external coding-agent binaries.

## Cleanup Pass

1. Extract local runtime environment assembly into `LocalContainerService::build_execution_env`.
2. Keep approval-service selection, process spawn timeout, child tracking, cancellation storage, and exit monitor setup in `start_execution_inner`.
3. Do not change the names or values of any runtime `VK_*` variables.

## Verification

- `cargo test -p local-deployment start_execution_script_stores_db_stream_handle_on_success --lib`
- `cargo test -p local-deployment container::tests --lib`
- Broader gates after the pass: `cargo check -p services -p local-deployment`, `cargo fmt --check`, `pnpm run check`, `pnpm run lint`, `git diff --check`.
