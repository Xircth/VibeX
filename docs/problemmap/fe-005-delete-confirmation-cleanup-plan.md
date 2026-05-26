# FE-005 Delete Confirmation Cleanup Plan

## Problem

`FileTreePanel.tsx` still builds delete confirmation copy inline inside the trash callback. The same callback also owns confirmation execution, API invocation, selected-node clearing, refresh, and error handling, so the copy policy is harder to test directly.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for file and folder delete confirmation inputs, including nested paths and leaf-name extraction.
- Keep `ConfirmDialog.show`, trash API execution, selected-node clearing, and refresh behavior in the component.

## Cleanup

- Extract `buildFileTreeDeleteConfirmation(relativePath, isFolder)` into `file-tree-utils.ts`.
- Wire `trashItem` through the helper.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
