# FE-002 ActionBar Dead Todo Cleanup Plan

## Scope

- Remove the hidden duplicate todo popover from `ActionBar`.
- Drop the now-unused `todos` prop and imports that only supported the hidden UI.
- Keep visible todo behavior owned by `TodoListButton` in the topbar.

## Behavior Lock

- Add an `ActionBar` test before deletion that asserts the hidden todo trigger is absent from the action bar and that the send action still works.
- The first run should fail because the hidden duplicate trigger is still present.

## Cleanup Steps

1. Add the failing `ActionBar` behavior lock.
2. Delete the hidden todo popover block and unused imports/types.
3. Remove the `todos` prop from the `ActionBar` call site.
4. Run targeted component tests, follow-up directory tests, frontend checks, full checks, lint, and whitespace check.

## Non-Goals

- Do not change visible topbar todo behavior.
- Do not alter send/queue/stop button semantics.
- Do not redesign the action bar layout.
