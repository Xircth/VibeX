# FE-005 New Item Path Cleanup Plan

## Problem

`FileTreePanel.tsx` builds create-file and create-folder relative paths inline in two separate callbacks. Both callbacks trim the user input, apply a fallback name, and join with an optional parent folder, so future changes can drift.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for root-level names, nested parent folders, trimmed names, and fallback names.
- Keep actual file/folder creation API calls and inline input state in `FileTreePanel.tsx`.

## Cleanup

- Extract `buildNewFileTreeItemRelativePath(parentFolder, rawName, fallbackName)` into `file-tree-utils.ts`.
- Wire both create-file and create-folder callbacks through the helper.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
