# RB-001 Stop InReview Policy Cleanup Plan

Scope: duplicate stop-time task status policy in `crates/local-deployment/src/container.rs`.

## Problem

`stop_execution` contains the same run-reason gate in both the missing-child and normal child paths: stopped executions mark the task `InReview` unless the process is a `DevServer`. The DB load and update side effects belong in `stop_execution`, but the repeated run-reason decision is pure completion policy.

## Behavior Lock

- `DevServer` stops do not mark the task `InReview`.
- Coding-agent stops mark the task `InReview`.
- Setup and cleanup script stops keep the existing mark-`InReview` behavior.

## Cleanup

- Add `should_mark_task_in_review_after_stop` to `process_completion`.
- Replace both duplicated inline `!matches!(..., DevServer)` checks in `stop_execution`.
- Do not move DB context loading, `Task::update_status`, process killing, handle cleanup, or msg-store cleanup.

## Verification

- `cargo test -p local-deployment process_completion --lib`
- `cargo check -p local-deployment`
- `cargo fmt --check`
- `pnpm run check`
- `pnpm run lint`
