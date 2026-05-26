# FE-002 Image Upload Application Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and
`frontend/src/components/tasks/follow-up/sessionComposerImages.ts`.

## Smells

- Boundary violation: `handleAttachImages` still combines upload response
  normalization, queued-message seed recovery, queue cancellation, attachment
  merge, preview revocation selection, and scratch image-path construction.
- Missing tests: queued image recovery plus uploaded-image replacement is only
  indirectly covered by lower-level helpers, not by the actual per-upload
  application policy.
- Complex implementation: a single callback loop hides which parts are pure state
  derivation and which parts are side effects.

## Behavior Lock

- Add a focused test for a successful uploaded image application:
  queued message state wins as the scratch message, queued images are restored
  before current attachments, duplicate uploaded paths replace the previous
  attachment and return the old preview for revocation, and scratch image paths
  match the next attachment list.

## Pass Order

1. Add a failing regression test for the uploaded-image application policy.
2. Extract the pure policy into `sessionComposerImages.ts`.
3. Replace the inline merge/seed logic in `TaskFollowUpSection.tsx` while keeping
   upload, queue cancellation, preview URL creation, and scratch persistence as
   component-owned side effects.
4. Re-run FE-002 helper tests and full project verification.
