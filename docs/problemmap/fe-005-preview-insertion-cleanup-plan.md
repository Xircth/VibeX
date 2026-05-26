# FE-005 Preview Insertion Cleanup Plan

## Problem

`FileTreePanel.tsx` still decides whether the selected preview range can be
inserted inline in `handleAddSelection`. The callback mixes preview kind/path
guards, selection presence checks, snippet construction, insertion side effect,
and popover closing.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for preview insertion text
  derivation.
- Lock text-preview snippet construction and null results for image previews,
  missing paths, and missing selections.

## Cleanup

- Extract `getFilePreviewInsertionText` into `file-tree-utils.ts`.
- Keep `handleAddSelection` responsible only for calling `onInsertText` when the
  helper returns text and then closing the preview.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
