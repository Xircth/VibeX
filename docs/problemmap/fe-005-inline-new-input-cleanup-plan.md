# FE-005 Inline New Input Cleanup Plan

## Scope

- `frontend/src/components/file-tree/FileTreePanel.tsx`
- `frontend/src/components/file-tree/file-tree-utils.ts`
- `frontend/src/components/file-tree/file-tree-utils.test.ts`
- ProblemMap ledger entries for FE-005

## Smell

`FileTreePanel` still duplicates new-item type branching for inline input presentation and creation fallback names. The file/folder default name and icon path policy is split between `confirmNewFile`, `confirmNewFolder`, and `renderInlineNewInput`, which makes future copy or default-name changes easy to miss.

## Behavior Lock

Add focused tests for:
- File inline input config uses `untitled`, file icon path, and `isFolder: false`.
- Folder inline input config uses `新建文件夹`, folder icon path, and `isFolder: true`.

## Cleanup

Extract `getFileTreeInlineNewInputConfig` into `file-tree-utils.ts`, then use it for creation fallback names and inline input rendering.

## Verification

- Red test first.
- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
