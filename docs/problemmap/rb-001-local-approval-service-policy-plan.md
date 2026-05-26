# RB-001 Local Approval-Service Policy Cleanup Plan

## Scope

- Move the pure "does this executor action need the interactive approval bridge" decision out of `LocalContainerService::start_execution_inner`.
- Keep approval bridge construction, noop service construction, DB handles, notification service, environment assembly, process spawn, child tracking, cancellation-token storage, and exit monitor setup in `start_execution_inner`.

## Behavior Lock

- Add direct unit coverage in `crates/local-deployment/src/process_completion.rs` proving Codex, Claude Code, and Opencode base executors require the approval bridge.
- Add direct unit coverage proving script actions and absent base executors use the noop approval service path.

## Implementation

- Add a small pure helper that accepts the optional base executor and returns whether the bridge path is required.
- Replace the inline `match executor_action.base_executor()` in `start_execution_inner` with the helper while preserving the existing service construction branches.

## Verification

- Run the process-completion tests first as a red behavior lock.
- After implementation, run `cargo test -p local-deployment process_completion --lib`.
- Run `cargo check -p local-deployment`, `cargo fmt --check`, `pnpm run check`, and `pnpm run lint`.
