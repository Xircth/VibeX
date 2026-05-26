# FE-002 SessionComposerInput Context Cleanup Plan

Scope: `frontend/src/components/tasks/follow-up/SessionComposerInput.tsx` and its `TaskFollowUpSection` call site.

## Smell

`SessionComposerInput` still exposes a wide flat prop surface for execution, workspace, repo, project, task, and shortcut context even though those values are read together to drive typeahead and image-preview behavior. The parent call site has to thread many loosely related optional values through the same boundary as the editable value and callbacks.

## Behavior Locks

- Textarea changes call `onChange` with the next value.
- `Enter` submits when the send shortcut is `Enter`.
- `Ctrl+Enter`/`Meta+Enter` submits when the send shortcut is `CmdEnter`.
- Plain `Enter` does not submit for `CmdEnter`.
- Disabled input blocks keyboard submit.

## Cleanup Pass

1. Add `SessionComposerInput.test.tsx` before changing the prop boundary.
2. Introduce a named `SessionComposerInputContext` prop for shortcut/task/workspace/repo/project/executor context.
3. Move the current flat context props into `context` at the `TaskFollowUpSection` call site.
4. Keep value, images, and callbacks as first-class props because they are the live editing surface.

## Non-Goals

- Do not change typeahead query behavior.
- Do not change image preview/remove behavior.
- Do not change send shortcut semantics.

## Verification

- Red/green or lock-first targeted Vitest for `SessionComposerInput`.
- Follow-up directory regression tests.
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
