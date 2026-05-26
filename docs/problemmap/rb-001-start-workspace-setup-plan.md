# RB-001 Start Workspace Setup Plan

## Scope

- Files: `crates/services/src/services/container_actions.rs`, `crates/local-deployment/src/container.rs`.
- Smell: `LocalContainerService::start_workspace_with_session` embeds setup orchestration policy directly in the DB/session startup flow. The current `all()` check also relies on empty-iterator truthiness to mean "no setup scripts, start coding directly".

## Behavior Lock

- Add direct unit coverage for:
  - no setup scripts selecting direct coding-agent start,
  - all setup scripts marked parallel selecting parallel setup start before coding,
  - any sequential setup script selecting one sequential setup chain before coding.

## Cleanup Pass

1. Extract setup start-mode selection into a pure helper owned by `container_actions`.
2. Keep action construction, DB lookups, workspace creation, and process starts in `LocalContainerService`.
3. Preserve existing run-reason behavior: no setup starts the coding action as `CodingAgent`; all-parallel setup starts setup scripts as `SetupScript` and coding as `CodingAgent`; mixed/sequential setup starts the chained action as `SetupScript`.

## Verification

- `cargo test -p services container_actions --lib`
- Relevant local runtime tests after wiring: `cargo test -p local-deployment container::tests --lib`
- Broader gates after the pass: `cargo check -p services -p local-deployment`, `cargo fmt --check`, `pnpm run check`, `pnpm run backend:lint`, `pnpm run lint`, `git diff --check`.
