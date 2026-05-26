# FE-002 ActionBar Running Controls Cleanup Plan

Scope: `frontend/src/components/tasks/follow-up/ActionBar.tsx` and a new running-controls component under `frontend/src/components/tasks/follow-up/`.

## Smell

`ActionBar` still owns the running-attempt branch inline: queued-vs-queueable selection, compacting suppression, queue/cancel loading states, missing-session guards, and stop button rendering. This makes the parent action bar keep too much nested conditional JSX after the queue policy has already been extracted and tested elsewhere.

## Behavior Locks

- When running and not compacting, queued state renders a cancel-queue button.
- When running and not compacting, non-queued state renders a queue button.
- Queue button is disabled when loading, missing a session id, or no queueable content exists.
- Queue/cancel buttons show a spinner during queue loading.
- Queue/cancel buttons are hidden while compacting.
- Stop button always renders in running mode, calls `onStopExecution`, and is disabled/spinner-only while stopping.

## Cleanup Pass

1. Add `ActionBarRunningControls.test.tsx` before implementation.
2. Extract `ActionBarRunningControls` for the running-attempt branch.
3. Replace the inline running branch in `ActionBar`.
4. Remove now-unused running-control icon imports from `ActionBar`.

## Non-Goals

- Do not change how `ActionBar` derives `hasQueueableContent`.
- Do not change idle send or clear-review controls.
- Do not change queue/cancel/stop callback semantics.

## Verification

- Red/green targeted Vitest for `ActionBarRunningControls`.
- Existing `ActionBar.test.tsx` and action-bar subcomponent tests.
- Follow-up directory regression tests.
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
