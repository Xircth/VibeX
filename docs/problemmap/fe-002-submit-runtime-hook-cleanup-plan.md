# FE-002 Submit Runtime Hook Cleanup Plan

Scope: `TaskFollowUpSection` queue-message and submit-shortcut side effects.

## Smells

- Boundary violation: `TaskFollowUpSection.tsx` still builds queued follow-up
  payloads, clears stopping state, cancels debounced draft saves, persists the
  current scratch draft, queues messages, and chooses send-vs-queue shortcut
  behavior inside component-local callbacks.
- Mixed responsibility: pure submit decisions live in `sessionComposerSubmit.ts`,
  but runtime orchestration still sits in the render component.
- Missing hook-level behavior lock: current tests prove the pure decisions, not
  the side-effect order and callback wiring used by the composer UI.

## Behavior Lock

- Add `UseSessionComposerSubmitActions.test.tsx` before implementation.
- Cover explicit queueing, empty/no-profile suppression, non-running shortcut
  send, running shortcut queueing, and already-queued shortcut suppression.

## Cleanup Order

1. Add the failing hook test.
2. Extract `useSessionComposerSubmitActions` beside the composer runtime hooks.
3. Replace the inline `TaskFollowUpSection.tsx` queue/submit callbacks with the
   hook return values.
4. Run targeted submit tests, the full follow-up directory, frontend checks,
   repo checks, lint, and whitespace validation.
