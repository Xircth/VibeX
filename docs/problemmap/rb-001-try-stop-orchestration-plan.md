# RB-001 Try-Stop Orchestration Plan

Scope: `ContainerService::try_stop` in `crates/services/src/services/container.rs`,
with service-level behavior locks in `crates/local-deployment/src/container.rs`.

## Smell

`try_stop` has a DB traversal plus nested selection/stop loop inside the trait
default method. The pure `should_stop_execution` policy is tested, but the
service path that loads workspace sessions and process rows is not locked at
the same level.

## Behavior Lock

Add a local-runtime service test proving `try_stop(workspace, false)`:

1. stops running non-dev executions for the workspace;
2. skips running dev-server executions;
3. skips already-completed executions.

## Cleanup

1. Keep `should_stop_execution` as the pure selection policy.
2. Extract only the per-session process traversal/stop loop into a helper.
3. Leave error tolerance and `stop_execution` side effects unchanged.

## Verification

- New `try_stop` service-level selection test.
- Existing stop and process-completion tests.
- Services/local-deployment checks, format, full repo check/lint.
