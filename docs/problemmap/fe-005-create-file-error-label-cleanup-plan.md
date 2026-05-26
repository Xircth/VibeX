# FE-005 Create File Error Label Cleanup Plan

## Problem

`FileTreePanel.tsx` still shows an English user-facing toast when creating a file fails, while the surrounding file-tree UI is Chinese and other nearby actions use Chinese labels. This is a small historical inconsistency, but it is visible behavior.

## Behavior Lock First

- Add a component test that starts root-level file creation, forces `saveFile` to fail, and asserts the readable Chinese failure toast.
- Keep file creation path construction and refresh behavior unchanged.

## Cleanup

- Replace the create-file failure toast with readable Chinese.

## Verification

- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
