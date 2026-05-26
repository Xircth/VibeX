# FE-005 Folder Expansion Cleanup Plan

## Problem

`FileTreePanel.tsx` still owns folder expansion policy inline. The component
calculates "all visible folders expanded", prunes expanded folders after tree
changes, toggles every visible folder, and toggles a single folder through
separate ad hoc `Set` mutations.

## Behavior Lock First

- Add direct `file-tree-utils.test.ts` coverage for folder expansion policy.
- Lock pruning stale expanded paths, all-visible-expanded detection, expand-all,
  collapse-all, and single-folder toggling.

## Cleanup

- Extract folder expansion helpers into `file-tree-utils.ts`.
- Keep the component responsible only for passing current state into the
  helpers and committing the returned `Set`.

## Verification

- `pnpm vitest run src/components/file-tree/file-tree-utils.test.ts`
- `pnpm vitest run src/components/file-tree/FileTreePanel.truncated.test.tsx`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
