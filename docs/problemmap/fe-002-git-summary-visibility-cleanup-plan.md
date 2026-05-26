# FE-002 Git Summary Visibility Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerGitSummary.ts`.

## Smell

- Boundary violation: changed-file summary visibility is derived inline in JSX while repo and changed-file counting already live in the git-summary helper.
- Missing test: zero changed files should suppress the summary, and positive counts should show it.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: the changed-file summary appears only when `fileCount > 0`.

## Cleanup Pass

1. Extract pure changed-file summary visibility derivation.
2. Keep tooltip rendering and displayed counts in the component.
3. Preserve the current `fileCount > 0` behavior exactly.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerGitSummary.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
