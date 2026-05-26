# FE-002 Focus Runtime Hook Cleanup Plan

## Scope

- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/useSessionComposerFocus.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerFocus.test.tsx`
- ProblemMap ledger entries for FE-002.

## Smell

`TaskFollowUpSection` still owns composer focus state and inline focus/blur JSX handlers. That state drives hotkey scope activation, so the focus boundary should be isolated and tested instead of living as anonymous handlers in the main component.

## Behavior Lock

Add a hook-level regression test covering initial unfocused state, focus activation, internal blur preservation, and external blur deactivation.

## Cleanup Steps

1. Add a focused hook for composer focus state and event handlers.
2. Replace `TaskFollowUpSection` inline `onFocus` / `onBlur` handlers with the hook return values.
3. Keep the existing hotkey hook inputs unchanged.
4. Run the new hook test, hotkey hook test, full follow-up suite, frontend/repo check and lint, and `git diff --check`.

## Non-Goals

- Do not alter hotkey scope policy.
- Do not change composer DOM structure, styling, or keyboard shortcuts.
- Do not broaden this pass into submit, queue, or compact behavior.
