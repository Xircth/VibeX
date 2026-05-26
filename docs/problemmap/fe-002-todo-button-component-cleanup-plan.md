# FE-002 Todo Button Component Cleanup Plan

## Scope

- Move the inline `TodoListButton` presentation component out of `TaskFollowUpSection.tsx`.
- Preserve the existing todo count, empty state, status markers, and popover content.
- Keep todo-state derivation in `sessionComposerTodos.ts`; do not change composer runtime behavior.

## Behavior Locks

- Add component tests for empty-state presentation and non-empty todo count/list rendering before moving the component.
- Keep existing follow-up helper tests green.

## Cleanup Steps

1. Add a failing component test for the missing `TodoListButton` module.
2. Move the inline component into `frontend/src/components/tasks/follow-up/TodoListButton.tsx`.
3. Replace the inline component in `TaskFollowUpSection.tsx` with the imported component and delete no-longer-needed imports/types.
4. Run the new component test, follow-up directory tests, frontend check/lint, project check/lint, and `git diff --check`.
