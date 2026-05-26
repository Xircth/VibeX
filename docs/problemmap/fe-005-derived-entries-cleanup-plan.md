# FE-005 File Tree Derived Entries Cleanup Plan

Scope: `frontend/src/components/file-tree/FileTreePanel.tsx` and `frontend/src/components/file-tree/file-tree-utils.ts`.

## Smell

`FileTreePanel` derives merged file lists, merged directory lists, gitignored sets, seeded lazy-loadable directories, and effective lazy-loadable directories in several adjacent `useMemo` blocks. This is pure state derivation, but it is embedded in a component that already owns IO, preview state, context menus, and drag/drop.

## Behavior Locks

- Base file and directory entries merge with lazy entries without duplicates.
- Gitignored file and directory sets merge with lazy gitignored sets.
- `lazyLoadAllDirectories` marks every merged directory as lazy-loadable.
- Special directories such as `node_modules` are lazy-loadable even when full lazy loading is off.
- Explicitly discovered lazy-loadable directories remain included.

## Cleanup Pass

1. Add derived-entry tests to `file-tree-utils.test.ts` before implementation.
2. Add a pure `deriveFileTreeEntries` helper.
3. Replace the adjacent merge/lazy-loadable `useMemo` blocks with one component-level memo.
4. Keep tree building, expansion, and drag/drop behavior unchanged.

## Non-Goals

- Do not change directory sorting or tree collapsing.
- Do not change lazy directory loading side effects.
- Do not change drag/drop behavior.

## Verification

- Red/green targeted Vitest for `file-tree-utils`.
- Existing truncated root-scan file-tree tests.
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
