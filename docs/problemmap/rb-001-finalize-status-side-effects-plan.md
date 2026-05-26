# RB-001 Finalize Status Side Effects Plan

Scope: `crates/services/src/services/container.rs` default finalize/orphan
status persistence, with service-level behavior locks in
`crates/local-deployment/src/container.rs`.

## Smell

`ContainerService::finalize_task` and orphan cleanup both persist session/task
`InReview` state with hand-written duplicate DB update blocks. The notification
message policy is already extracted, but the status side effect remains copied
inside async orchestration paths.

## Behavior Lock

Add service-level local-runtime tests proving:

1. `finalize_task` marks both the session and linked task `InReview` for a
   completed coding-agent context.
2. startup orphan cleanup marks both the session and linked task `InReview` for
   orphaned coding-agent executions.

## Cleanup

1. Keep notification construction and delivery policy unchanged.
2. Extract only the repeated session/task `InReview` persistence helper.
3. Reuse the helper from `finalize_task` and orphan cleanup.

## Verification

- New finalize status test.
- New orphan status test.
- Existing local container and process-completion tests.
- Local-deployment check, format, and repo checks.
