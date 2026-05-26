# FE-005 Context Menu Header Cleanup Plan

## Problem

`FileTreePanel.tsx` still derives context-menu header text inline in JSX. The
portal render splits the selected relative path to find its leaf label and
special-cases the workspace root label directly in the render tree.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for context-menu header
  derivation.
- Lock root fallback behavior, nested file/folder leaf labels, and path
  subtitle visibility.

## Cleanup

- Extract `deriveFileTreeContextMenuHeader` into `file-tree-utils.ts`.
- Keep the portal render responsible only for displaying the derived title and
  optional subtitle.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
