# RB-001 Stop Exit-Code Policy Cleanup Plan

## Scope

- Move the pure "which exit code should be persisted for a manually completed/stopped process status" decision out of `LocalContainerService::stop_execution`.
- Keep completion persistence, child lookup, cancellation, process-group killing, message-store cleanup, DB-stream waiting, task status updates, and after-head capture in `stop_execution`.

## Behavior Lock

- Add direct unit coverage in `crates/local-deployment/src/process_completion.rs` proving a manual `Completed` status persists exit code `0`.
- Add direct unit coverage proving `Failed`, `Killed`, `Running`, and other non-completed statuses persist no exit code in this manual stop path.

## Implementation

- Add a small pure helper that maps `ExecutionProcessStatus` to the stop-path exit code.
- Replace the inline `if status == Completed { Some(0) } else { None }` branch in `stop_execution` with the helper.

## Verification

- Run the process-completion tests first as a red behavior lock.
- After implementation, run `cargo test -p local-deployment process_completion --lib`.
- Run `cargo check -p local-deployment`, `cargo fmt --check`, `pnpm run check`, and `pnpm run lint`.
