# RB-001 Start Process Record Plan

## Scope

- Files: `crates/services/src/services/container.rs`, `crates/local-deployment/src/container.rs`.
- Smell: `start_execution` still owns execution-process record creation, repository state capture, and startup orchestration in one body.

## Behavior Lock

- Extend the startup failure service test to assert the created execution process keeps the requested run reason and writes one repository-state row for the workspace repo.
- Keep using the unknown executor variant so the test covers record creation before spawn without launching an external agent.

## Cleanup Pass

1. Extract startup execution-process record creation into `create_start_execution_process`.
2. Keep no-repository and missing-container-ref errors in the helper because they are part of the process-record creation preconditions.
3. Do not move status updates, workspace unarchive, coding-turn creation, executor spawn, normalization, or stream setup in this pass.

## Verification

- `cargo test -p local-deployment start_execution_unknown_executor_marks_failed_and_restores_review_state --lib`
- `cargo test -p services container_workflow --lib`
- `cargo test -p local-deployment container::tests --lib`
- Broader gates after the pass: `cargo check -p services -p local-deployment`, `cargo fmt --check`, `pnpm run check`, `pnpm run lint`, `git diff --check`.
