# RB-001 Start Approval Service Construction Plan

## Scope

- Files: `crates/local-deployment/src/container.rs`.
- Smell: `LocalContainerService::start_execution_inner` still owns approval-service construction details even though the bridge/noop eligibility policy already lives in `process_completion`.

## Behavior Lock

- Reuse the existing `process_completion` unit coverage proving Codex, Claude Code, and Opencode actions use the bridge path while non-interactive actions use noop.
- Keep the service-level script startup test in the verification set so non-interactive startup still proves real spawn behavior after construction is moved.

## Cleanup Pass

1. Extract approval-service object construction into `LocalContainerService::create_executor_approval_service`.
2. Keep `process_completion::should_create_executor_approval_bridge` as the single policy owner.
3. Do not change bridge constructor arguments or noop fallback behavior.

## Verification

- `cargo test -p local-deployment approval_bridge --lib`
- `cargo test -p local-deployment start_execution_script_stores_db_stream_handle_on_success --lib`
- Broader gates after the pass: `cargo test -p services container_workflow --lib`, `cargo test -p local-deployment container::tests --lib`, `cargo test -p local-deployment process_completion --lib`, `cargo check -p services -p local-deployment`, `cargo fmt --check`, `pnpm run check`, `pnpm run lint`, `git diff --check`.
