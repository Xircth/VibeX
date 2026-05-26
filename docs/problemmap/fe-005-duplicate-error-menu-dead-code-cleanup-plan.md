# FE-005 Duplicate Error And Dead Menu Cleanup Plan

## Problem

`FileTreePanel.tsx` has a real mojibake duplicate-failure toast and retains a large commented native-menu implementation. The dead block repeats stale context-menu behavior and contains more mojibake strings, making the current portal menu harder to review.

## Behavior Lock First

- Add a component test that opens the file context menu, chooses duplicate, forces `copyItem` to fail, and asserts the readable duplicate-failure toast.
- Keep copy/move/create semantics unchanged; this pass only fixes the displayed error and removes unreachable commented code.

## Cleanup

- Replace the duplicate failure toast with readable Chinese.
- Delete the commented-out native menu block.

## Verification

- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
