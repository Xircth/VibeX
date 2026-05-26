# FE-002 Todo List Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and a new focused todo-list helper under `frontend/src/components/tasks/follow-up/`.

## Smell

- Boundary violation: todo-list count visibility and status presentation are derived directly inside JSX.
- Duplication: running status accepts both `in_progress` and `in-progress`, and that status check is repeated for class and marker selection.
- Missing test: completed, running, cancelled, and empty-list presentation behavior is not locked outside the component.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: zero todos hide the count and show the empty state; positive counts show the count.
- Preserve existing status presentation:
  - `completed` uses the check marker and green marker class.
  - `in_progress` and `in-progress` use the filled-circle marker and blue marker class.
  - unknown statuses use the hollow-circle marker and muted marker class.
  - `cancelled` keeps the default marker and strikes through the content.

## Cleanup Pass

1. Extract pure todo-list state and todo item presentation derivation.
2. Replace the duplicated JSX status checks with helper output.
3. Keep popover rendering, labels, and layout in `TaskFollowUpSection`.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerTodos.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
