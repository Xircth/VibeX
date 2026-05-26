# RB-001 Stop Cleanup Side-Effects Plan

## Scope

- Reduce duplication in `LocalContainerService::stop_execution` by grouping the repeated message-store and DB-stream cleanup sequence.
- Keep completion persistence, child lookup, cancellation, process-group killing, task status updates, and after-head capture in `stop_execution`.
- Do not change `try_stop`, `finalize_task`, reset behavior, or process killing semantics.

## Behavior Lock

- Add a service-level local-runtime test for the no-child stop path.
- Prove the path updates the execution process to killed, clears the in-memory message store entry, appends `Finished` to the retained store, drains/removes the DB stream handle, and marks the linked task `InReview`.

## Implementation

- Add a private async helper on `LocalContainerService` for the repeated stop cleanup sequence:
  - take DB stream handle
  - remove message store and push `Finished`
  - wait briefly for DB-stream persistence
- Replace both duplicated stop path blocks with that helper.

## Verification

- Run the new stop test before refactoring as the behavior lock.
- After implementation, run the stop test, `cargo test -p local-deployment process_completion --lib`, `cargo check -p local-deployment`, `cargo fmt --check`, `pnpm run check`, and `pnpm run lint`.
