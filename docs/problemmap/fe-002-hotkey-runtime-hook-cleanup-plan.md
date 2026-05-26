# FE-002 Hotkey Runtime Hook Cleanup Plan

Scope: `TaskFollowUpSection` hotkey scope activation side effects.

## Smells

- Boundary violation: `TaskFollowUpSection.tsx` still owns `react-hotkeys-hook`
  scope enable/disable effects directly.
- Duplication risk: the pure hotkey scope decision lives in
  `sessionComposerHotkeys.ts`, but the runtime cleanup and activation policy are
  embedded in the component instead of a focused composer hook.
- Missing hook-level behavior lock: current coverage proves the activation
  decision, not the side-effect lifecycle.

## Behavior Lock

- Add `UseSessionComposerHotkeys.test.tsx` before implementation.
- Cover active scope enablement, inactive scope disablement, cleanup disablement,
  and active-to-inactive rerender behavior.

## Cleanup Order

1. Add the failing hook test.
2. Extract `useSessionComposerHotkeys` beside the existing composer runtime
   hooks.
3. Replace the inline `TaskFollowUpSection.tsx` effects with the hook call.
4. Run targeted hotkey tests, the full follow-up test directory, frontend checks,
   repo checks, lint, and whitespace validation.
