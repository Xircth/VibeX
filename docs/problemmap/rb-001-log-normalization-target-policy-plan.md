# RB-001 Log Normalization Target Policy Cleanup Plan

Scope: post-start log normalization target selection in `crates/services/src/services/container.rs`.

## Problem

After executor startup, `start_execution` inlines the action-type match that decides whether normalized log processing should start and which executor profile plus effective working directory to use. The actual msg-store lookup and executor invocation belong in `start_execution`, but the action-to-normalization-target rule is pure workflow policy.

## Behavior Lock

- Coding-agent initial, follow-up, and review actions produce normalization targets.
- Script actions do not produce normalization targets.
- The target profile comes from the action executor config.
- The target working directory respects each request's `working_dir` override relative to the workspace root.

## Cleanup

- Add a pure `container_workflow` helper returning the normalization profile and working directory for supported action types.
- Replace the inline action-type match in `start_execution`.
- Do not move msg-store lookup, QA mock normalization, executor cache lookup, or tracing.

## Verification

- `cargo test -p services container_workflow --lib`
- `cargo check -p services -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
