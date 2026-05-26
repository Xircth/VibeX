# RB-001 After-Head Capture Cleanup Plan

## Scope

- Keep this pass limited to recording execution-process repository `after_head_commit` values.
- Preserve completion status updates, session/task status updates, child cleanup, message-store cleanup, commit execution, notification policy, and orphan failure semantics.
- Do not collapse the `ContainerService` trait or change runtime-specific workspace creation.

## Behavior Lock

- Add service-level local-runtime coverage proving orphan cleanup records the current repository HEAD into `execution_process_repo_states.after_head_commit` while marking the orphaned running process failed.
- Reuse the existing stop-without-child test that already proves stopped executions record `after_head_commit`.

## Edit Plan

1. Extract a shared `ContainerService` helper that records current HEAD values for every repo in an `ExecutionContext`.
2. Use the helper from startup orphan cleanup.
3. Use the same helper from `LocalContainerService::update_after_head_commits`.

## Verification

- `cargo test -p local-deployment orphan --lib`
- `cargo test -p local-deployment stop_execution_without_child_records_after_head_commit --lib`
- `cargo test -p local-deployment container::tests --lib`
- `cargo check -p services -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
