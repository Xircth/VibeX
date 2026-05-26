# FE-002 Git Summary Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and a new
`frontend/src/components/tasks/follow-up/sessionComposerGitSummary.ts` helper.

## Smells

- Boundary violation: `TaskFollowUpSection` owns git-summary repo selection and
  changed-file counting even though those are pure derivations for the composer
  top bar.
- Missing tests: selected-repo fallback and staged/unstaged duplicate path
  counting are user-visible in the file-count badge but not directly locked.
- Complex implementation: the component already coordinates runtime send,
  scratch, queue, and prompt flows; keeping git-summary derivation inline keeps
  unrelated responsibilities coupled.

## Behavior Lock

- Add focused tests for summary repo selection:
  prefer the selected repo only when it exists in the repo list, otherwise fall
  back to the first repo, otherwise `null`.
- Add focused tests for changed-file counting:
  dedupe paths across staged and unstaged file lists.

## Pass Order

1. Add failing regression tests for git-summary derivation.
2. Extract pure helpers into `sessionComposerGitSummary.ts`.
3. Replace the component's inline `useMemo` bodies with the helpers.
4. Re-run FE-002 helper tests and full project verification.
