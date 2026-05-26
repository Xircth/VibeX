# FE-002 After-Send Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and
`frontend/src/components/tasks/follow-up/sessionComposerSubmit.ts`.

## Smells

- Boundary violation: `onAfterSendCleanup` mixes UI state reset, image preview
  revocation selection, scratch hydration id update, and scratch deletion gate
  inside the component hook argument.
- Missing tests: the "successful send clears message/images and deletes only an
  identified scratch" behavior is user-visible but not directly locked.
- Complex implementation: cleanup policy is adjacent to submit behavior, but the
  component owns it as side-effect choreography.

## Behavior Lock

- Add a focused test for after-send cleanup state:
  local message becomes empty, attachments are cleared, prior previews are
  selected for revocation, scratch id is marked hydrated, and scratch deletion is
  gated by the presence of a scratch id.

## Pass Order

1. Add the failing regression test for after-send cleanup policy.
2. Extract the pure cleanup decision into `sessionComposerSubmit.ts`.
3. Replace the inline cleanup policy in `TaskFollowUpSection.tsx`.
4. Re-run FE-002 helper tests and full project verification.
