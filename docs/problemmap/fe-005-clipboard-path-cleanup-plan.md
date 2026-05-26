# FE-005 Clipboard Path Cleanup Plan

## Problem

`FileTreePanel.tsx` still derives relative and absolute clipboard text inside async clipboard callbacks. The callbacks should own `navigator.clipboard` side effects, while root-relative fallback (`.`) and root-absolute fallback (`workspacePath`) are pure policy.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for root and non-root relative clipboard text.
- Add direct coverage for absolute clipboard text choosing the workspace path for root and resolved absolute paths for non-root items.

## Cleanup

- Extract `getFileTreeRelativeClipboardText(relativePath)` and `getFileTreeAbsoluteClipboardText(relativePath, absolutePath, workspacePath)` into `file-tree-utils.ts`.
- Wire `copyRelativePath` and `copyAbsolutePath` through the helpers while preserving clipboard failure suppression.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
