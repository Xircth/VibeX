# RB-001 Finalize Notification Policy Plan

Scope: `crates/services/src/services/container_workflow.rs` and `crates/services/src/services/container.rs`.

## Behavior To Preserve

- `finalize_task` still updates session and task status before notification decisions.
- Killed executions do not send completion notifications.
- Completed and failed executions use the existing notification title/message format.
- Unexpected non-terminal statuses do not send notifications and remain warning-worthy at the caller.

## Smell Addressed

- `finalize_task` mixes DB writes, notification side effects, and pure notification message policy.

## Pass Order

1. Add pure unit coverage for completion notification policy.
2. Route `finalize_task` through the pure helper without changing DB or notification side effects.
3. Run targeted service tests and full quality gates.

## Deferred

- Do not move DB status updates or notification delivery out of `finalize_task` in this pass.
