# FE-002 Pending Approval Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and
`frontend/src/components/tasks/follow-up/sessionComposerSubmit.ts`.

## Smells

- Boundary violation: the component directly parses normalized conversation entry
  internals to decide whether the composer can type/send.
- Missing tests: pending tool approval blocks typing, but the entry-shape
  detection is only embedded in render orchestration.
- Complex implementation: send gating already lives in `sessionComposerSubmit`,
  while one of its inputs is still derived through component-local structural
  inspection.

## Behavior Lock

- Add a focused test for pending approval detection:
  only normalized tool-use entries with `pending_approval` status block the
  composer; completed tool-use entries and non-normalized entries do not.

## Pass Order

1. Add a failing regression test for pending approval detection.
2. Extract the pure detection helper into `sessionComposerSubmit.ts`.
3. Replace the component's inline `entries.some` parsing with the helper.
4. Re-run FE-002 helper tests and full project verification.
