# RB-001 Local Commit Message Policy Cleanup Plan

Scope: `crates/local-deployment/src/container.rs` commit message selection inside `LocalContainerService::get_commit_message`.

## Problem

The local runtime still mixes coding-agent turn lookup, error logging, and commit message formatting in one async method. The DB lookup belongs in `container.rs`, but the formatting policy is pure process-completion behavior and should be behavior-locked outside the service implementation.

## Behavior Lock

- Coding-agent summary is used verbatim when present, including the current empty-string behavior.
- Coding-agent missing/error summary falls back to `Commit changes from coding agent for workspace {workspace_id}`.
- Cleanup scripts use `Cleanup script changes for workspace {workspace_id}`.
- Other run reasons use `Changes from execution process {execution_process_id}`.

## Cleanup

- Add a pure commit-message helper to `process_completion`.
- Keep `CodingAgentTurn` DB access and logging in `LocalContainerService::get_commit_message`.
- Do not change commit execution, repo status checks, or next-action/finalization flow.

## Verification

- `cargo test -p local-deployment process_completion --lib`
- `cargo check -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
