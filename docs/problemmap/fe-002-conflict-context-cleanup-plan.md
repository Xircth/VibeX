# FE-002 Conflict Context Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and a new
`frontend/src/components/tasks/follow-up/sessionComposerConflicts.ts` helper.

## Smells

- Boundary violation: `TaskFollowUpSection` owns conflict repo selection and
  conflict-resolution prompt construction even though both are pure send-context
  derivations.
- Duplication risk: similar conflict repo detection exists in other follow-up and
  branch-status surfaces, making drift likely.
- Missing tests: the composer prompt behavior is not directly locked for
  rebase-in-progress, empty conflict files, or merge/rebase prompt formatting.

## Behavior Lock

- Add focused tests for conflict repo selection:
  first repo with rebase-in-progress or conflicted files wins.
- Add focused tests for conflict instructions:
  no instructions are produced without conflicted files; populated conflicts
  include source branch, target branch, repo name, operation, and file list.

## Pass Order

1. Add failing regression tests for conflict context derivation.
2. Extract pure helpers into `sessionComposerConflicts.ts`.
3. Replace the component's inline conflict `useMemo` bodies with the helpers.
4. Re-run FE-002 helper tests and full project verification.
