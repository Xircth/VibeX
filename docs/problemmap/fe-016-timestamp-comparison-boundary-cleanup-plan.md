# FE-016 timestamp comparison boundary cleanup plan

## Scope

- Files:
  - `frontend/src/lib/workspaceBranchOptions.ts`
  - `frontend/src/lib/devServerUtils.ts`
  - `frontend/src/hooks/git/useGitBranches.ts`
  - `frontend/src/hooks/useProjectWorkspacesStream.ts`
  - `frontend/src/hooks/useProjectWorktrees.ts`
  - `frontend/src/hooks/useKanbanProjectSessions.ts`
  - selected Kanban/workspace presentation helpers that sort by updated timestamps
- Smell: duplicated date parsing, weak generated-type/runtime boundary.
- Current issue: after FE-015 fixed created-at sorting, other frontend timestamp comparisons still parse dates locally with `new Date(...).getTime()` or direct `Date` object comparison.

## Behavior lock first

Reuse the shared `dateTimestamp` behavior lock from FE-015:

- ISO strings convert to millisecond timestamps;
- `Date` objects convert to the same timestamp;
- invalid strings preserve JavaScript `Date` behavior by returning `NaN`.

For this pass, keep existing sort order and tie behavior unchanged. Do not change display-only date formatting.

## Cleanup order

1. Re-run the shared date helper tests as the behavior lock.
2. Replace non-display timestamp comparisons with `dateTimestamp`.
3. Limit the pass to sorting/comparison logic; leave UI formatting calls as `new Date(...).toLocale...`.
4. Search for remaining non-display timestamp comparisons after edits.

## Verification

- `pnpm vitest run src/utils/date.test.ts`
- targeted existing tests where touched helpers already have coverage
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
