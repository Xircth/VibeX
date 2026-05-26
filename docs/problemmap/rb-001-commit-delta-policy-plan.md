# RB-001 Commit-Delta Policy Cleanup Plan

## Scope

- Move the pure "should this completed execution inspect repository HEAD deltas before deciding whether to start the next action" decision out of the local runtime exit monitor.
- Keep repository-state reads, git HEAD checks, commit execution, next-action startup, and finalization side effects in `LocalContainerService`.

## Behavior Lock

- Add direct unit coverage in `crates/local-deployment/src/process_completion.rs` proving coding-agent runs inspect execution commit deltas.
- Add direct unit coverage proving setup scripts, cleanup scripts, dev servers, and archive scripts skip the commit-delta inspection path.

## Implementation

- Add a small pure helper that accepts `ExecutionProcessRunReason` and returns whether commit-delta inspection is required.
- Replace the inline `matches!(run_reason, CodingAgent)` branch in `spawn_exit_monitor` with the helper.

## Verification

- Run the process-completion tests first as a red behavior lock.
- After implementation, run `cargo test -p local-deployment process_completion --lib`.
- Run `cargo check -p local-deployment`, `cargo fmt --check`, `pnpm run check`, and `pnpm run lint`.
