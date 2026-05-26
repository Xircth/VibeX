# FE-002 Image Removal Runtime Hook Cleanup Plan

Scope: `TaskFollowUpSection` image removal side effects.

## Smells

- Boundary violation: `TaskFollowUpSection.tsx` still owns image removal state
  mutation, preview URL revocation, and draft scratch persistence inside a local
  callback.
- Runtime leakage: the callback reaches into `executorProfileRef.current`
  directly, coupling image removal to draft persistence details.
- Missing hook-level behavior lock: pure image helper tests cover removal
  derivation, but not the runtime wiring that revokes previews and persists the
  next image path list.

## Behavior Lock

- Add `UseSessionComposerImageRemoval.test.tsx` before implementation.
- Cover removing matching images, revoking removed previews, saving the remaining
  image paths, preserving no-match behavior, and reading the current executor
  profile ref at removal time.

## Cleanup Order

1. Add the failing hook test.
2. Extract `useSessionComposerImageRemoval` beside existing composer runtime
   hooks.
3. Replace the inline `TaskFollowUpSection.tsx` image removal callback with the
   hook return value.
4. Run targeted image tests, the full follow-up directory, frontend checks, repo
   checks, lint, and whitespace validation.
