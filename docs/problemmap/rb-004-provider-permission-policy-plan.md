# RB-004 Provider Permission Policy Plan

## Scope

- Files: `crates/executors/src/executors/acp/provider.rs`.
- Smell: ACP provider permission-policy mapping is embedded directly in `AcpBackedExecutor::apply_overrides`, mixing executor override merging with protocol policy for approvals and plan mode.

## Behavior Lock

- Add direct unit coverage for:
  - `PermissionPolicy::Auto` disabling approval forwarding without clearing an existing mode,
  - `PermissionPolicy::Supervised` enabling approval forwarding without changing mode,
  - `PermissionPolicy::Plan` enabling approval forwarding and forcing ACP plan mode.

## Cleanup Pass

1. Extract the ACP permission-policy mapping into a pure helper.
2. Keep model, agent, and Codex reasoning override precedence inside `apply_overrides`.
3. Do not change the existing behavior that Auto/Supervised preserve the current mode while Plan overrides it.

## Verification

- `cargo test -p executors acp::provider --lib`
- Broader gates after the pass: `cargo check -p executors`, `cargo fmt --check`, `pnpm run check`, `pnpm run backend:lint`, `pnpm run lint`, `git diff --check`.
