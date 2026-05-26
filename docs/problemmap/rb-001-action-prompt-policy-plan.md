# RB-001 Action Prompt Policy Cleanup Plan

Scope: coding-agent-turn prompt selection in `crates/services/src/services/container.rs`.

## Problem

`start_execution` creates a `CodingAgentTurn` by matching the executor action type inline. The DB insert belongs in `start_execution`, but the action-to-prompt eligibility rule is pure workflow policy: coding-agent initial requests, coding-agent follow-ups, and review requests create turns; script actions do not.

## Behavior Lock

- Coding-agent initial requests create a turn with the initial prompt.
- Coding-agent follow-up requests create a turn with the follow-up prompt.
- Review requests create a turn with the review prompt.
- Script requests do not create coding-agent turns.

## Cleanup

- Add a pure `container_workflow` helper that returns the coding-agent-turn prompt for supported action types.
- Replace the inline `match executor_action.typ()` in `start_execution`.
- Do not move `CodingAgentTurn::create`, execution-process creation, repo-state capture, or executor startup.

## Verification

- `cargo test -p services container_workflow --lib`
- `cargo check -p services -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
