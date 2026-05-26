# FE-005 Preview Selection Range Cleanup Plan

## Problem

`FileTreePanel.tsx` still derives preview line-selection ranges inside a React callback. The rule is simple but central to click, shift-click, and drag-selection behavior, so leaving it embedded makes interaction changes harder to review and test.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for anchor-before-index, index-before-anchor, and single-line selection.
- Keep mouse event handling, drag refs, and popover rendering in `FileTreePanel.tsx`; only the pure range derivation is in scope.

## Cleanup

- Extract `deriveFilePreviewSelectionRange(anchor, index)` into `file-tree-utils.ts`.
- Replace the inline `Math.min`/`Math.max` callback body with the helper.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
