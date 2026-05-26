# RB-001 Reset Target Policy Plan

Scope: `crates/services/src/services/container_workflow.rs` and `crates/services/src/services/container.rs`.

## Behavior To Preserve

- `reset_session_to_process` prefers the target process repo state's `before_head_commit`.
- If that value is absent, it falls back to the previous process `after_head_commit`.
- If neither commit exists, the repo is skipped.
- Git reset options keep the existing relationship: `log_skip_when_dirty` follows `perform_git_reset`.

## Smell Addressed

- `reset_session_to_process` mixes target-commit selection and reset option construction with DB lookup, worktree resolution, stopping, and process dropping side effects.

## Pass Order

1. Add pure unit coverage for reset target and reset option policy.
2. Route `reset_session_to_process` through those helpers without changing DB/git/stop/drop side effects.
3. Run targeted service tests and full quality gates.

## Deferred

- Do not move DB lookup, git reconciliation, `try_stop`, or `drop_at_and_after` out of `reset_session_to_process` in this pass.
