# RB-001 Start Failure Side Effects Plan

## Scope

- Files: `crates/services/src/services/container.rs`, `crates/local-deployment/src/container.rs`.
- Smell: `start_execution` owns both startup orchestration and the failure cleanup side effects that mark execution/session/task state and append user-visible error logs.

## Behavior Lock

- Add a local service test for a coding-agent start failure caused by an unknown executor variant.
- Assert the start path creates the execution process and coding-agent turn before the spawn attempt, then marks the process failed, returns session/task to `InReview`, unarchives the workspace, and appends the stderr start-failure log.
- Use the unknown-profile failure path so the test does not spawn an external agent process.

## Cleanup Pass

1. Extract the start-failure completion side effects into a private `finish_failed_start` helper on `ContainerService`.
2. Keep the helper inside the service trait because it uses the same persistence APIs and should remain shared by local/deployment implementations.
3. Do not change success startup, normalization, DB stream, or executor spawning behavior in this pass.

## Verification

- `cargo test -p local-deployment start_execution_unknown_executor_marks_failed_and_restores_review_state --lib`
- `cargo test -p services container_workflow --lib`
- `cargo test -p local-deployment container::tests --lib`
- Broader gates after the pass: `cargo check -p services -p local-deployment`, `cargo fmt --check`, `pnpm run check`, `pnpm run lint`, `git diff --check`.
