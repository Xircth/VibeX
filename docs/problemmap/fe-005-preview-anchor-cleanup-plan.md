# FE-005 Preview Anchor Cleanup Plan

## Problem

`FileTreePanel.tsx` still calculates preview popover position inline in
`openPreview`. The component owns DOM measurement plus viewport clamping,
estimated preview dimensions, padding, and arrow positioning in the same
callback that mutates preview state.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for preview anchor derivation.
- Lock the existing left/top/height/arrow clamping behavior for a normal
  viewport and a constrained viewport near the top-left edge.

## Cleanup

- Extract `deriveFilePreviewAnchor` into `file-tree-utils.ts`.
- Keep `openPreview` responsible only for reading `getBoundingClientRect` and
  committing preview state.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
