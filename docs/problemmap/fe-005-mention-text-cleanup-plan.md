# FE-005 Mention Text Cleanup Plan

## Problem

`FileTreePanel.tsx` still builds inserted file-reference mention text inline in
the row action button. The render branch knows that file mentions append a
trailing space while folder mentions do not.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for mention text derivation.
- Lock file trailing-space behavior and folder no-trailing-space behavior.

## Cleanup

- Extract `getFileTreeMentionText` into `file-tree-utils.ts`.
- Keep the row action responsible only for calling `onInsertText`.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
