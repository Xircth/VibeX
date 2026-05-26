# RB-003 Init And Identity Cleanup Plan

Scope: `crates/git/src/lib.rs` residual repository initialization and commit identity logic.

## Problem

`GitService` has already been split into focused operation modules, but `lib.rs` still owns repository initialization, initial commit creation, CLI commit identity setup, and the public `commit` entry point. That keeps policy-heavy behavior in the crate root after the rest of the facade has been decomposed.

## Behavior Lock

- Prove repository initialization creates `main`, writes an initial commit, and sets `HEAD` to `refs/heads/main`.
- Prove `ensure_main_branch_exists` initializes an empty repository once and leaves an already-initialized repository unchanged.
- Prove CLI commit identity setup is repo-local, fills missing `user.name` and `user.email`, and preserves existing config values.

## Cleanup

- Move initialization and identity helpers into a dedicated Git module.
- Keep the public `GitService` API unchanged.
- Do not change CLI-vs-libgit2 mutation behavior.
- Leave cross-cutting error text helpers in `lib.rs` unless a caller-specific owner becomes clear.

## Verification

- `cargo test -p git init_identity --lib`
- `cargo test -p git`
- `cargo check -p git`
- `pnpm run check`
- `pnpm run lint`
