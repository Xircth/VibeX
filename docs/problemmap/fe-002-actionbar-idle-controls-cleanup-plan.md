# FE-002 ActionBar Idle Controls Cleanup Plan

Scope: `frontend/src/components/tasks/follow-up/ActionBar.tsx` and a new idle-controls component under `frontend/src/components/tasks/follow-up/`.

## Smell

`ActionBar` still owns the idle branch inline: review-clear visibility, send disabled gates, send loading state, and conflict-vs-send label selection. After the image, utility, and running controls have been extracted, this remaining branch is the last high-signal nested JSX surface in the action bar itself.

## Behavior Locks

- Clear-review button renders only when comments exist.
- Clear-review button calls `onClearComments` and is disabled when the composer is not editable.
- Send button calls `onSendFollowUp` when enabled.
- Send button is disabled when send is unavailable, the composer is not editable, or a new-session confirmation is pending.
- Send button uses the conflict-resolution label when conflict instructions exist.
- Send button keeps a stable accessible name while showing its loading spinner.

## Cleanup Pass

1. Add `ActionBarIdleControls.test.tsx` before implementation.
2. Extract `ActionBarIdleControls` for the idle branch.
3. Replace the inline idle branch in `ActionBar`.
4. Remove now-unused idle-control icon imports from `ActionBar`.

## Non-Goals

- Do not change running queue/cancel/stop controls.
- Do not change how parent code derives comments or conflict instructions.
- Do not change callback semantics or send eligibility policy.

## Verification

- Red/green targeted Vitest for `ActionBarIdleControls`.
- Existing `ActionBar.test.tsx` and action-bar subcomponent tests.
- Follow-up directory regression tests.
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
