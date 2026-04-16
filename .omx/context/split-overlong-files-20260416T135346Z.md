# Context Snapshot: Split Overlong Files

## Task statement
Inspect the repository, identify overlong project source files, and split them into smaller modules without changing existing behavior. Before any structural refactor, commit the current worktree state.

## Desired outcome
- The current dirty worktree is preserved in a baseline commit.
- Clearly overlong source files are decomposed into smaller modules with stable interfaces.
- Existing behavior remains unchanged and is verified with focused tests plus repo checks.

## Known facts / evidence
- The repository is already dirty with a large number of tracked and untracked changes.
- The repo requires Lore-format commit messages.
- Ralph execution in this repo expects a task-specific context snapshot plus PRD and test-spec artifacts before implementation.
- Initial line-count scan of real source files surfaced these notable candidates:
  - `src-tauri/src/commands/workspaces.rs`
  - `crates/git/src/lib.rs`
  - `crates/executors/src/executors/claude.rs`
  - `frontend/src/components/file-tree/FileTreePanel.tsx`
  - `src-tauri/src/commands/config.rs`

## Constraints
- Do not change behavior.
- Commit the current worktree before any decomposition edits.
- Keep diffs small, reviewable, and reversible.
- Prefer deleting or extracting to existing patterns rather than adding new abstractions.
- No new dependencies.
- Run lint, typecheck, tests, and static analysis after changes.

## Unknowns / open questions
- Which overlong files are already partly protected by tests versus needing targeted regression coverage.
- Whether all top candidates are suitable for safe extraction in the current dirty branch.
- Whether some long files are generated, asset, or protocol-heavy files that should not be split.

## Likely codebase touchpoints
- `frontend/src/components/file-tree/*`
- `src-tauri/src/commands/*`
- `crates/git/src/*`
- `crates/executors/src/executors/*`
- Relevant existing frontend and Rust test files near touched modules
