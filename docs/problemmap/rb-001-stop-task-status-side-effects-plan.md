# RB-001 Stop Task-Status Side-Effects Plan

## Scope

- Reduce duplication in `LocalContainerService::stop_execution` by grouping the repeated "load context, apply stop-time InReview policy, persist task status" block.
- Keep process completion persistence, child lookup, cancellation, process-group killing, message-store cleanup, DB-stream waiting, and after-head capture in `stop_execution`.
- Do not change stop candidate selection, dev-server filtering, queued-message behavior, finalization, or reset behavior.

## Behavior Lock

- Keep the existing no-child coding-agent stop test proving a stopped coding-agent process marks the linked task `InReview`.
- Add a no-child dev-server stop test proving dev-server cleanup still completes process/log cleanup but does not mark the linked task `InReview`.

## Implementation

- Add a private async helper on `LocalContainerService` for stop-time task-status persistence.
- Replace both duplicated `ExecutionProcess::load_context` / `Task::update_status` blocks in `stop_execution` with the helper.

## Verification

- Run the new dev-server stop test before refactoring as the behavior lock.
- After implementation, run targeted container tests, process-completion tests, `cargo check -p local-deployment`, `cargo fmt --check`, `pnpm run check`, and `pnpm run lint`.
