# FE-005 Preview Status Cleanup Plan

## Problem

`FileTreePanel.tsx` still owns preview kind, image-path eligibility, and effective loading/error status derivation inline. That leaves text preview state, image preview state, and path-kind policy spread across adjacent render logic.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for text preview state, image preview state, null preview path, `Error` image failures, and string/null image failures.
- Keep file loading and `useBinaryAssetPreview` behavior out of this pass; only the pure display-status decision is in scope.

## Cleanup

- Extract preview kind and effective status derivation into `file-tree-utils.ts`.
- Wire `FileTreePanel.tsx` to consume the helper while preserving existing state and hook ownership.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
