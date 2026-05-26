# RB-001 Orphan InReview Policy Cleanup Plan

Scope: startup orphan execution cleanup policy in `crates/services/src/services/container.rs`.

## Problem

`cleanup_orphan_executions` marks orphaned running processes as failed, then inlines a run-reason gate before moving the owning session/task back to `InReview`. That gate is pure workflow policy, while the function itself owns DB traversal, failure persistence, after-head capture, and status updates.

## Behavior Lock

- Orphaned coding-agent, setup-script, and cleanup-script processes mark session/task `InReview`.
- Orphaned dev-server and archive-script processes do not mark session/task `InReview`.

## Cleanup

- Add a pure `container_workflow` helper for orphan cleanup InReview eligibility.
- Replace the inline `matches!` gate in `cleanup_orphan_executions`.
- Do not move DB traversal, failure updates, after-head commit capture, or session/task persistence.

## Verification

- `cargo test -p services container_workflow --lib`
- `cargo check -p services -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
