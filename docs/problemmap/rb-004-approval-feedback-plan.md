# RB-004 Approval Feedback Plan

## Scope

- Files: `crates/executors/src/executors/acp/normalize_logs.rs`.
- Smell: the ACP stdout normalization event loop still builds denied approval `UserFeedback` entries inline, mixing event dispatch with approval feedback presentation and tool-name lookup.

## Behavior Lock

- Add an end-to-end normalization fixture that sends:
  1. `RequestPermission` with a tool-call update,
  2. denied `ApprovalResponse` with a reason.
- Assert the request produces a tool entry and the denial produces a `UserFeedback` entry with the denied tool name and trimmed denial reason.

## Cleanup Pass

1. Extract denied approval feedback construction into a helper.
2. Keep request-permission tool-entry handling and approval response dispatch order unchanged.
3. Do not change approved, pending, timed-out, or absent-tool-state behavior.

## Verification

- `cargo test -p executors acp::normalize_logs --lib`
- Broader gates after the pass: `cargo check -p executors`, `cargo fmt --check`, `pnpm run check`, `pnpm run backend:lint`, `pnpm run lint`, `git diff --check`.
