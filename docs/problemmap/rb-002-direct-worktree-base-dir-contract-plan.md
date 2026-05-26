# RB-002 Direct Worktree Base-Dir Contract Plan

Scope: `crates/local-deployment/src/container.rs` local runtime path helpers only.

## Behavior To Lock

- Non-worktree local execution resolves the workspace base to the registered repo path.
- Worktree execution keeps `container_ref` as the local runtime base directory, including external direct-checkout roots.
- Direct external single-repo worktrees are recognized only outside VibeX-owned workspace storage.
- Agent working directories that already start with the repo name continue to target the repo subdirectory, not the direct external checkout root.
- Local runtime repo-path derivation preserves a workspace root that is itself a git checkout.

## Smells Addressed

- Missing tests around the local-only semantics that blocked further RB-002 consolidation.
- Historical ambiguity between service-side execution base-dir helpers and local runtime external-worktree handling.

## Pass Order

1. Add focused unit tests for `normalized_workspace_base_dir`, `is_direct_external_worktree`, and local `workspace_repo_path` integration with git-checkout roots.
2. Run the local-deployment targeted tests.
3. Run full repo quality gates before updating ProblemMap status.

## Deferred

- Do not collapse `normalized_workspace_base_dir` into the service helper in this pass. That refactor needs integration coverage for `ensure_container_exists` and external worktree discovery.
