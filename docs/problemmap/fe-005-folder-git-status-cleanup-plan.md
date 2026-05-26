# FE-005 Folder Git Status Cleanup Plan

Scope: `frontend/src/components/file-tree/FileTreePanel.tsx` and `frontend/src/components/file-tree/file-tree-utils.ts`.

## Smell

`FileTreePanel` computes folder git status by recursively walking the built tree and choosing the highest-priority child status inline. This is pure derived display policy, but it is embedded beside component state, IO callbacks, preview handling, and drag/drop state.

## Behavior Locks

- File nodes read their direct git status from the file status map.
- Folder nodes inherit the highest-priority status from descendant files.
- Status priority remains `D > A > M > R > T`.
- Folders without descendant statuses are omitted from the folder status map.

## Cleanup Pass

1. Add folder git-status tests to `file-tree-utils.test.ts` before implementation.
2. Add a pure `deriveFolderGitStatusMap` helper.
3. Replace the inline recursive `useMemo` body in `FileTreePanel`.
4. Keep tree construction and row rendering behavior unchanged.

## Non-Goals

- Do not change git status priority.
- Do not change file-row CSS classes.
- Do not change drag/drop behavior.

## Verification

- Red/green targeted Vitest for `file-tree-utils`.
- Existing truncated root-scan file-tree tests.
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
