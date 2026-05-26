# RB-001 Start Coding Turn Plan

## Scope

- Files: `crates/services/src/services/container.rs`, `crates/local-deployment/src/container.rs`.
- Smell: `start_execution` still mixes execution process creation, workspace state, coding-agent turn persistence, executor spawn, failure handling, and normalization in one body.

## Behavior Lock

- Reuse the local service startup failure test because it already proves a coding-agent request creates a `CodingAgentTurn` with the prompt before executor spawn failure.
- Keep the existing pure `container_workflow::coding_agent_turn_prompt` coverage for action eligibility: initial, follow-up, and review requests create prompts; scripts do not.

## Cleanup Pass

1. Extract coding-agent turn persistence into `create_start_coding_agent_turn`.
2. Keep prompt eligibility in `container_workflow::coding_agent_turn_prompt`.
3. Do not alter execution process creation, workspace unarchive, executor spawn, failure handling, normalization, or stream setup.

## Verification

- `cargo test -p local-deployment start_execution_unknown_executor_marks_failed_and_restores_review_state --lib`
- `cargo test -p services container_workflow --lib`
- `cargo test -p local-deployment container::tests --lib`
- Broader gates after the pass: `cargo check -p services -p local-deployment`, `cargo fmt --check`, `pnpm run check`, `pnpm run lint`, `git diff --check`.
