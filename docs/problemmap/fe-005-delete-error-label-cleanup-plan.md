# FE-005 Delete Error Label Cleanup Plan

## Problem

`FileTreePanel.tsx` still shows an English user-facing toast when deleting a file or folder fails. The surrounding destructive action dialog and menu labels are Chinese, so this is visible historical inconsistency in the file-tree workflow.

## Behavior Lock First

- Add a component test that opens the context menu, confirms deletion, forces `trashItem` to fail, and asserts a readable Chinese failure toast.
- Keep the confirmation dialog contract, trash API path resolution, selection clearing, and refresh behavior unchanged.

## Cleanup

- Replace the delete failure toast with readable Chinese.

## Verification

- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
