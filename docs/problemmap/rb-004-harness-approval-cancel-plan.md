# RB-004 Harness Approval Cancel Plan

## Scope

- Files: `crates/executors/src/executors/acp/harness.rs`.
- Smell: ACP approval-denial cancellation policy is embedded inside the spawned event-forwarder loop, mixing event persistence, stdout forwarding, and session cancellation decisions.

## Behavior Lock

- Add direct unit coverage for:
  - denied approval responses with a non-empty reason cancelling the ACP session,
  - denied approval responses with blank or missing reasons not cancelling,
  - non-denied approval responses not cancelling.

## Cleanup Pass

1. Extract the approval-response cancellation predicate into a pure helper.
2. Keep stdout forwarding, session-file persistence, and actual `CancelNotification` dispatch in the event-forwarder loop.
3. Do not change the existing requirement that denial cancellation only happens when the user denial includes non-empty feedback.

## Verification

- `cargo test -p executors acp::harness --lib`
- Broader gates after the pass: `cargo check -p executors`, `cargo fmt --check`, `pnpm run check`, `pnpm run backend:lint`, `pnpm run lint`, `git diff --check`.
