# RB-002 Local Base Helper Consolidation Plan

Scope: `crates/services/src/services/workspace_paths.rs` and `crates/local-deployment/src/container.rs`.

## Behavior To Preserve

- Service execution base-dir behavior remains unchanged: a worktree container ref that points at the repo root resolves to its parent workspace directory.
- Local runtime base-dir behavior remains unchanged: worktree `container_ref` is the runtime base even when the path itself is a direct checkout.
- Non-worktree local runtime continues to use the registered repo path.

## Smell Addressed

- `local-deployment` still carries local base-dir path policy that belongs beside the other shared workspace path rules.

## Pass Order

1. Add pure shared helper tests for local-runtime base-dir behavior.
2. Replace `LocalContainerService::normalized_workspace_base_dir` internals with the shared helper.
3. Re-run shared helper tests, local container tests, and full quality gates.

## Deferred

- Keep `ensure_container_exists`, existing-worktree discovery, DB writes, copy/image behavior, and git side effects in local deployment.
