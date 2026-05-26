# FE-005 New Item Parent Expansion Cleanup Plan

## Problem

`FileTreePanel.tsx` duplicates the same parent-folder expansion policy in both
`openNewFilePrompt` and `openNewFolderPrompt`. Each callback decides that root
creation should not touch expanded folders, already-expanded parents should
preserve the existing `Set`, and collapsed parents should be added.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for parent expansion policy.
- Lock root no-op behavior, already-expanded reference preservation, and
  collapsed-parent expansion.

## Cleanup

- Extract `ensureFileTreeParentFolderExpanded` into `file-tree-utils.ts`.
- Wire both new-file and new-folder prompt callbacks through the helper.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
