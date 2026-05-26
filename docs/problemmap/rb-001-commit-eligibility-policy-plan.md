# RB-001 Commit Eligibility Policy Cleanup Plan

Scope: `crates/local-deployment/src/container.rs` run-reason gate in `try_commit_changes`.

## Problem

`try_commit_changes` mixes a pure run-reason eligibility policy with async commit-message lookup, workspace path derivation, repo status checks, and actual commit execution. The eligibility decision is small but important process-completion behavior and should live with the other tested completion policies.

## Behavior Lock

- `CodingAgent` executions are eligible for post-run commits.
- `CleanupScript` executions are eligible for post-run commits.
- Other run reasons are not eligible and return `false` without repo checks.

## Cleanup

- Add `should_try_commit_changes` to `process_completion`.
- Replace the inline `matches!` gate in `LocalContainerService::try_commit_changes`.
- Do not change commit-message lookup, repo status checks, or commit execution.

## Verification

- `cargo test -p local-deployment process_completion --lib`
- `cargo check -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
