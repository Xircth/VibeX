# RB-004 Permission Outcome Plan

## Scope

- Files: `crates/executors/src/executors/acp/client.rs`.
- Smell: ACP permission option selection and `ApprovalStatus` to `RequestPermissionOutcome` mapping are embedded inline in `AcpClient::request_permission`, making protocol policy hard to verify without exercising the full async approval service path.

## Behavior Lock

- Add direct unit coverage for:
  - no-approval auto mode selecting `allow_always` before `allow_once`,
  - auto mode falling back to the first option when no allow option exists,
  - approved approvals selecting `allow_once`,
  - denied approvals selecting `reject_once`,
  - missing approved option and timeout/pending behavior.

## Cleanup Pass

1. Extract pure permission outcome helpers for auto mode and resolved approval statuses.
2. Keep async approval-service request, feedback queueing, and `ApprovalResponse` event emission in `AcpClient::request_permission`.
3. Do not change ACP option preference order or cancellation behavior.

## Verification

- `cargo test -p executors acp::client --lib`
- Broader gates after the pass: `cargo check -p executors`, `cargo fmt --check`, `pnpm run check`, `pnpm run backend:lint`, `pnpm run lint`, `git diff --check`.
