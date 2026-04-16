# Test Spec: Split Overlong Files

## Verification targets

### Baseline commit
- Confirm a new commit exists before decomposition begins.
- Confirm the commit message follows the Lore protocol.

### Candidate selection
- Record the selected long-file candidates and why each is safe to split.
- Exclude generated files, assets, build output, and reference-only directories.

### Refactor verification
- For frontend modules, run targeted component/unit tests when touching files that already have nearby coverage or clear seams.
- For Rust modules, run targeted tests where available and `cargo check`/workspace tests as needed for touched crates.
- Run diagnostics on changed TypeScript files and repo checks required by touched areas.

## Regression commands
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- targeted Vitest runs for touched frontend modules
- `pnpm run backend:check`
- targeted `cargo test` for touched Rust crates or `cargo test --workspace` if scope requires it
