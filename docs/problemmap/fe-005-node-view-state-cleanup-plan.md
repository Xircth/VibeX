# FE-005 Node View-State Cleanup Plan

## Problem

`FileTreePanel.tsx` still derives each rendered node's view state inline at the
top of `renderNode`. Folder/file classification, lazy loading flags,
expandability, git status lookup, ignored-state lookup, selected/drop classes,
and row class string assembly are mixed directly with JSX rendering.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for node view-state derivation.
- Lock folder lazy/expanded/loading/error state, folder git status aggregation
  lookup, ignored/selected/drop classes, and regular file status classes.

## Cleanup

- Extract `deriveFileTreeNodeViewState` into `file-tree-utils.ts`.
- Keep `renderNode` responsible for event handlers, recursive rendering, and
  drag/drop wiring.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
