# RB-001 Start Status Policy Cleanup Plan

Scope: start-time status and archive policy in `crates/services/src/services/container.rs`.

## Problem

`start_execution` mixes DB orchestration with two pure policy checks:

- non-dev executions move the session/task to `InProgress`;
- archive-script executions do not clear workspace archive state.

The DB writes and execution-process creation belong in `start_execution`, but the run-reason decisions are workflow policy and should live with the other container workflow helpers.

## Behavior Lock

- Coding-agent, setup-script, cleanup-script, and archive-script starts mark sessions `InProgress`.
- Dev-server starts do not mark sessions/tasks `InProgress`.
- Tasks already `InProgress` are not redundantly updated.
- Archive-script starts do not unarchive the workspace; other run reasons do.

## Cleanup

- Add pure `container_workflow` helpers for start-time status and unarchive decisions.
- Replace the inline run-reason checks in `start_execution`.
- Do not move task lookup, session/task persistence, execution-process creation, repo-state capture, coding-agent-turn creation, or executor startup.

## Verification

- `cargo test -p services container_workflow --lib`
- `cargo check -p services -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
