# FE-005 Keyboard Action Cleanup Plan

## Problem

`FileTreePanel.tsx` still embeds selected-node keyboard shortcut decisions
inside the `keydown` effect. The effect mixes DOM filtering, platform modifier
detection, delete/copy shortcut policy, event cancellation, and async action
dispatch.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for keyboard action derivation.
- Lock Ctrl/Cmd Delete/Backspace delete behavior, Ctrl/Cmd+C absolute-path copy
  behavior, Shift+C suppression, missing selection suppression, and
  platform-specific primary modifier handling.

## Cleanup

- Extract `deriveFileTreeKeyboardAction` into `file-tree-utils.ts`.
- Keep the effect responsible for DOM target filtering, `preventDefault`, and
  dispatching `trashItem` / `copyAbsolutePath`.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
