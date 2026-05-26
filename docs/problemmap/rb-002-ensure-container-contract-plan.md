# RB-002 Ensure-Container Contract Plan

Scope: `crates/local-deployment/src/container.rs` integration-level behavior around `ensure_container_exists`.

## Behavior To Lock

- A configured direct external single-repo worktree is reused as the container root and is not converted into an app-owned multi-repo workspace.
- A configured direct external worktree path must already exist; missing external paths fail before workspace creation.
- When `container_ref` is absent, an existing git worktree for the workspace branch can be discovered and reused as the container root.

## Smells Addressed

- Private helper coverage alone is not enough to prove the async local runtime path.
- Direct external worktree behavior depends on DB lookup, git worktree discovery, storage-mode repair, and image/copy no-op paths.

## Pass Order

1. Add minimal DB fixtures and direct `LocalContainerService` construction for `ensure_container_exists` tests.
2. Add focused async tests for configured external roots, missing external roots, and discovered external worktrees.
3. Run local-deployment targeted tests, then full formatting/check/lint gates.

## Deferred

- Do not refactor `ensure_container_exists` in this pass. These tests are the behavior lock for the next simplification pass.
