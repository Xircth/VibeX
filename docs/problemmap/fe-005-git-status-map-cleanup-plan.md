# FE-005 Git Status Map Cleanup Plan

## Scope

- `frontend/src/components/file-tree/FileTreePanel.tsx`
- `frontend/src/components/file-tree/file-tree-utils.ts`
- `frontend/src/components/file-tree/file-tree-utils.test.ts`
- ProblemMap ledger entries for FE-005

## Smell

`FileTreePanel` still owns the raw `gitStatusFiles` array to `Map` conversion inline, while folder git status aggregation already lives in tested file-tree utilities. This keeps a small data-normalization rule in the render component and leaves duplicate-status overwrite behavior implicit.

## Behavior Lock

Add focused tests for:
- `undefined` git status input producing an empty map.
- ordered entries preserving last-write-wins semantics for duplicate paths.

## Cleanup

Extract `deriveFileTreeGitStatusMap` into `file-tree-utils.ts`, use it from `FileTreePanel`, and keep the change bounded to git-status normalization only.

## Verification

- Red test first.
- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
