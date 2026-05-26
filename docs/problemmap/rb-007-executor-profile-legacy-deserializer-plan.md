# RB-007 Executor Profile Legacy Deserializer Plan

## Scope

- `crates/executors/src/profile.rs`
- ProblemMap documentation for the backend/runtime review.

## Smell

`de_base_coding_agent_kebab` is labeled as deletable after a two-week window
from 2025-03-09, but it still sits on persisted serde boundaries for
`ExecutorProfileId` and `ExecutorConfig`. `BaseCodingAgent` itself only parses
canonical `SCREAMING_SNAKE_CASE`, so deleting the helper would reject older
stored JSON such as `claude-code`.

## Behavior Lock

1. Add focused tests proving both `ExecutorProfileId` and `ExecutorConfig`
   deserialize legacy kebab-case executor names.
2. Add a test proving the old `profile` alias still maps to `executor` for
   persisted `ExecutorProfileId` payloads.
3. Run `cargo test -p executors profile --lib` before and after the comment
   cleanup.

## Cleanup Order

1. Add the missing serde boundary tests.
2. Replace the stale time-boxed deletion comment with a durable compatibility
   contract.
3. Update ProblemMap evidence.
4. Run targeted and full verification gates.

## Explicit Non-Goals

- Do not remove legacy deserialization in this pass.
- Do not migrate user config or database rows.
- Do not change generated TypeScript types.
- Do not change executor profile lookup or variant normalization.
