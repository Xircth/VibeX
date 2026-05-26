# FE-005 Preview Image Path Cleanup Plan

## Scope

- `frontend/src/components/file-tree/FileTreePanel.tsx`
- `frontend/src/components/file-tree/file-tree-utils.ts`
- `frontend/src/components/file-tree/file-tree-utils.test.ts`
- ProblemMap ledger entries for FE-005

## Smell

`FileTreePanel` still owns preview image path eligibility inline: it checks `previewPath`, checks the preview kind, and then resolves the workspace-relative path before calling `useBinaryAssetPreview`. That policy belongs with the other preview derivation helpers and should be directly tested.

## Behavior Lock

Add focused tests for:
- Missing preview path returns `null`.
- Text previews return `null`.
- Image previews resolve through `resolveFileTreeAbsolutePath`, including already-absolute paths.

## Cleanup

Extract `getFilePreviewImagePath` into `file-tree-utils.ts` and replace the component `useMemo` body with the helper call.

## Verification

- Red test first.
- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
