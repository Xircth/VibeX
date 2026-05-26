# TAURI-001 Include Module Cleanup Plan

Scope: `src-tauri/src/commands/workspaces.rs` and the lowest-risk included
workspace command file.

## Problem

`workspaces.rs` uses textual `include!` for every workspace command shard. That
means included files share parent imports and namespace implicitly, so even type
definitions and small helpers are not honest Rust modules.

## First Slice

Convert only `workspaces/types.rs` to a real module:

- add explicit imports inside `types.rs`;
- replace `include!("workspaces/types.rs")` with `mod types; pub use types::*;`;
- keep all command shard includes unchanged for now;
- keep `detect_package_manager` available to included command code through the
  parent re-export;
- do not move command handlers or change command behavior in this pass.

## Second Slice

Convert `workspaces/commit_commands.rs` to a real module:

- add explicit imports for Tauri state, app error, deployment access, UUID, git
  types, and diff response types;
- call the existing worktree resolver through the parent module;
- replace the textual include with `mod commit_commands; pub use
  commit_commands::*;`;
- keep command bodies unchanged.

## Third Slice

Convert `workspaces/pr_import.rs` to a real module:

- add explicit imports for DB models, git remote/CLI helpers, container actions,
  deployment access, UUID, and local request/response types;
- replace the textual include with `mod pr_import; pub use pr_import::*;`;
- remove the stale trailing `Commit operations` marker now that commit commands
  live in a separate module;
- keep command behavior unchanged.

## Fourth Slice

Convert `workspaces/workspace_crud.rs` to a real module:

- add explicit imports for workspace/task/session/process DB models, deployment
  access, executor config, Git branch cleanup, workspace manager cleanup, UUID,
  and local request types;
- call the existing workspace sync/recovery helpers through the parent module
  while `workspace_sync.rs` remains included;
- replace the textual include with `mod workspace_crud; pub use
  workspace_crud::*;`;
- keep CRUD command bodies and background cleanup behavior unchanged.

## Fifth Slice

Convert `workspaces/workspace_queries.rs` to a real module:

- add explicit imports for query DB models, deployment/container access, git
  response types, serialization, paths, UUID, and app state/error types;
- keep the existing git panel helper in this file, but expose it only to sibling
  workspace command modules with `pub(super)`;
- update `commit_commands.rs` to call the resolver through the sibling module
  instead of relying on a parent-level textual include;
- keep query and git panel command bodies unchanged.

## Sixth Slice

Convert `workspaces/workspace_sync.rs` to a real module:

- add explicit imports for path/hash-map utilities, workspace/task/repo DB
  models, deployment access, git worktree listing, UUID, and app state/error
  types;
- expose only `recover_workspace_container_ref` and
  `sync_project_workspaces_from_local_worktrees` as `pub(super)` for CRUD
  command callers;
- update `workspace_crud.rs` to call those helpers through the sibling module;
- keep local worktree discovery, storage repair, and import behavior unchanged.

## Seventh Slice

Convert `workspaces/pull_requests.rs` to a real module:

- add explicit imports for PR/merge/session/process DB models, deployment,
  executor follow-up actions, git host and git error types, workspace path
  resolution, paths, UUID, and local PR response types;
- keep the PR auto-description follow-up helper private inside the PR module;
- replace the textual include with `mod pull_requests; pub use
  pull_requests::*;`;
- keep PR creation, attachment, browser-open, auto-description, and comment
  query behavior unchanged.

## Eighth Slice

Convert `workspaces/workspace_scripts.rs` to a real module:

- add explicit imports for process/session/workspace/repo DB models, deployment,
  executor setup helpers, script actions, shell resolution, workspace path
  helpers, UUID, and local script/editor response types;
- keep `get_gh_cli_setup_action` private inside the script module;
- replace the textual include with `mod workspace_scripts; pub use
  workspace_scripts::*;`;
- keep dev-server stop/start, companion install, setup/cleanup/archive script,
  GitHub CLI setup, and editor-open behavior unchanged.

## Ninth Slice

Convert `workspaces/git_operations.rs` to a real module:

- add explicit imports for hash maps, paths, merge/task/workspace/repo DB
  models, deployment/container access, git errors/conflict types, branch type,
  UUID, and local git operation response types;
- replace the final textual include with `mod git_operations; pub use
  git_operations::*;`;
- remove any parent-module imports no longer needed after the final workspace
  shard owns its dependencies;
- keep branch status, direct merge, push, rebase, conflict abort/continue,
  rebase-back, target branch update, and branch rename behavior unchanged.

## Behavior Lock

This pass is compile-boundary cleanup, so the proof is the same exported command
surface compiling with the type module no longer borrowing parent imports.

## Verification

- `cargo check -p vibex`
- `pnpm run check`
- `pnpm run lint`
