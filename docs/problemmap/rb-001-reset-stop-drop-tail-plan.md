# RB-001 Reset Stop/Drop Tail Plan

Scope: `ContainerService::reset_session_to_process` in
`crates/services/src/services/container.rs`, with service-level behavior locks in
`crates/local-deployment/src/container.rs`.

## Smell

`reset_session_to_process` still owns several side-effect categories at once:
DB context loading, worktree reset policy, stop orchestration, and execution-row
dropping. The pure reset target policy is tested, but the final stop/drop tail is
not locked with a service-level test.

## Behavior Lock

Add a local-runtime service test proving reset:

1. stops running non-dev executions in the workspace before trimming history;
2. keeps dev-server executions running when `try_stop(..., false)` is used;
3. soft-drops the target process and later processes in the target session;
4. leaves processes before the target process visible.

## Cleanup

1. Leave git reset target selection and worktree reconciliation unchanged.
2. Extract only the reset tail that stops workspace executions and soft-drops
   target-session rows.
3. Keep drop inclusivity and stop policy unchanged.

## Verification

- New reset stop/drop service-level test.
- Existing local container/process-completion tests.
- Services/local-deployment checks, format, full repo check/lint.
