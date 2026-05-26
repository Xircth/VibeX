# FE-005 Context Menu Position Cleanup Plan

## Problem

`FileTreePanel.tsx` still calculates context-menu portal coordinates inline in
JSX. The render tree reads `window.innerHeight` and `window.innerWidth` directly
and embeds the menu-size and padding clamps inside style construction.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for context-menu position
  derivation.
- Lock normal cursor placement and viewport-edge clamping.

## Cleanup

- Extract `deriveFileTreeContextMenuPosition` into `file-tree-utils.ts`.
- Keep the portal render responsible only for passing cursor and viewport
  dimensions into the helper.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
