# RB-010 executor action agent-resolution cleanup plan

## Scope

- Files:
  - `crates/executors/src/actions/mod.rs`
  - `crates/executors/src/actions/coding_agent_initial.rs`
  - `crates/executors/src/actions/coding_agent_follow_up.rs`
  - `crates/executors/src/actions/review.rs`
- Smell: duplication, weak execution boundary, missing tests.
- Current issue: initial, follow-up, and review action spawn paths each repeat the same executor profile lookup, override application, and approval-service attachment logic. This is a runtime executor boundary and should not drift per action type.

## Behavior lock first

Add focused unit coverage for shared agent resolution:

- a configured Codex agent applies model, reasoning, and permission-policy overrides;
- an unknown profile variant returns `UnknownExecutorType` with the requested profile id.

The tests should fail before the shared helper exists.

## Cleanup order

1. Add the failing action helper tests.
2. Add a small `configured_coding_agent` helper in `actions::mod`.
3. Replace the three duplicated profile lookup / override / approval blocks with the helper.
4. Keep action-specific spawn calls, QA-mode mock behavior, follow-up reset handling, and review session handling unchanged.

## Verification

- `cargo test -p executors actions --lib`
- `cargo check -p executors`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
