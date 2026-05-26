# FE-002 Editor Runtime Hook Cleanup Plan

Scope: `TaskFollowUpSection` editor-change side effects.

## Smells

- Boundary violation: `TaskFollowUpSection.tsx` still reads React Query queue
  cache, builds cancel mutation inputs, mutates queue state, clears follow-up
  errors, and synchronizes draft persistence refs inside one render component
  callback.
- Runtime/ref leakage: `setFollowUpMessageRef` exists only to keep editor-change
  and uploaded-image draft application fresh, but the ref lifecycle is embedded
  in the component.
- Missing hook-level behavior lock: pure queue helpers cover decisions, but not
  the component runtime wiring that applies those decisions.

## Behavior Lock

- Add `UseSessionComposerEditorChange.test.tsx` before implementation.
- Cover queued draft cancellation, local-message update, draft persistence sync,
  follow-up error clearing, non-queued suppression, and latest draft setter usage
  after rerender.

## Cleanup Order

1. Add the failing hook test.
2. Extract `useSessionComposerEditorChange` beside existing composer runtime
   hooks.
3. Replace the inline `TaskFollowUpSection.tsx` editor-change/ref logic with the
   hook return values.
4. Run targeted editor/queue/image/prompt tests, the full follow-up directory,
   frontend checks, repo checks, lint, and whitespace validation.
