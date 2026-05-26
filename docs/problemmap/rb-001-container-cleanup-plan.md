# RB-001 Container Runtime Cleanup Plan

Scope: `crates/services/src/services/container.rs` and the local runtime call
sites that implement or consume `ContainerService`.

## Problem

`ContainerService` is presented as a runtime abstraction, but it also owns
task-finalization policy, action-chain scheduling policy, reset/stop behavior,
execution startup, and DB/notification side effects. The trait has one real
local implementation, so this shape combines a portability boundary with the
main orchestration workflow.

The cleanup must not hide behind "works today". The target is to move policy
and workflow responsibilities toward testable owning modules, while preserving
the current runtime behavior.

## Constraints

- Do not collapse or delete the trait in this pass. Future deployment/runtime
  extension plans are uncertain, and deleting the boundary would be a broad
  architectural decision.
- Do not move DB-heavy async workflow methods before their behavior is locked.
- Do not change execution ordering, notification timing, or next-action
  scheduling semantics.
- Keep this pass focused on pure policy extraction so local deployment behavior
  can be verified with existing service checks.

## Behavior Locks Before Edits

Add focused unit coverage for pure workflow policy:

- `DevServer` executions never finalize.
- setup-script executions with no next action never finalize.
- failed and killed executions finalize even if a next action exists, except
  where the existing earlier guards apply.
- completed executions finalize only when no next action exists.
- script to script next actions run as `SetupScript`.
- coding/review to script next actions run as `CleanupScript`.
- script to coding/review and coding/review to coding/review next actions run
  as `CodingAgent`.

## First Implementation Slice

1. Add `crates/services/src/services/container_workflow.rs`.
2. Move the pure finalization decision into
   `should_finalize_execution(status, run_reason, action)`.
3. Move next-action run-reason classification into
   `next_action_run_reason(current_action, next_action)`.
4. Wire `ContainerService::should_finalize` and
   `ContainerService::try_start_next_action` through the helpers.
5. Leave all async side effects, DB writes, process spawning, log streaming, and
   notification behavior in their existing methods.

## Verification

- `cargo test -p services container_workflow --lib`
- `cargo check -p services -p local-deployment`
- `pnpm run check`
- `pnpm run lint`

## Follow-up Boundary

After this pass, the next honest cleanup step is not more file movement. It is
to lock higher-level async transitions around `finalize_task`,
`try_start_next_action`, `try_stop`, and `reset_session_to_process`, then move
those workflows out of the trait into an orchestration owner.

## Pass 2: Local Exit Completion Policy

The local exit watcher still mixes process-exit decoding, commit/next-action
eligibility, queued-message policy, DB updates, and cleanup in one spawned async
block. The safe next slice is to extract only the pure decision rules:

- map process exit result to `(exit_code, ExecutionProcessStatus)`;
- decide when a completed process should commit and consider a next action;
- decide whether a coding-agent process may start its cleanup/next action based
  on committed or already-authored commits;
- decide whether queued follow-up messages are allowed to execute.

This pass must leave DB updates, `try_commit_changes`, `try_start_next_action`,
`finalize_task`, `Scratch::delete`, message-store cleanup, and child-handle
cleanup in the existing watcher.

## Pass 3: Stop Selection Policy

`ContainerService::try_stop` still mixes DB traversal, stop side effects, and
process-selection policy. The safe slice is to extract only the selection rule:

- stop only running processes;
- skip dev-server processes unless `include_dev_server` is true;
- leave the actual `stop_execution` call and error handling in the trait method.

## Pass 4: Script Action-Chain Builders

The trait still carries repeated setup/cleanup/archive script-action builders.
The safe slice is to move pure action-chain construction into an owning helper
module and delete builder API that has no current callers:

- one shared helper should build same-context script chains while preserving repo
  order, script text, Bash language, context, and repo-name working directory;
- cleanup and archive callers should use the helper directly;
- sequential setup should keep wrapping setup scripts in reverse order so the
  resulting chain executes in the original repo order before the coding action;
- standalone parallel setup actions should keep producing a single setup script
  action per repo;
- expose the helper module for Tauri/local-deployment callers instead of routing
  these pure builders through `ContainerService`.
