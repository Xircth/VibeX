# RB-001 Executor Exit Signal Policy Cleanup Plan

Scope: `crates/local-deployment/src/container.rs` executor exit-signal status mapping in `spawn_exit_monitor`.

## Problem

The local runtime still maps `ExecutorExitResult` values to platform-specific `ExitStatus` values inside the service file. That policy is pure process-completion behavior and sits next to DB updates, child-process cleanup, queued-message handling, and finalization orchestration.

## Behavior Lock

- `ExecutorExitResult::Success` maps to a successful exit status and then to `Completed` with exit code `0`.
- `ExecutorExitResult::Failure` maps to a failed exit status and then to `Failed` with a non-zero exit code.
- A closed executor exit-signal channel keeps the existing assumption that the process completed successfully.

## Cleanup

- Move platform-specific success/failure exit-status helpers into `process_completion`.
- Add a pure `executor_signal_exit_status` helper.
- Keep process-group killing, DB completion updates, commit/next-action logic, queued-message handling, and finalization in `spawn_exit_monitor`.

## Verification

- `cargo test -p local-deployment process_completion --lib`
- `cargo check -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
