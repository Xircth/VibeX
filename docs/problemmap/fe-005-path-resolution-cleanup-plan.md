# FE-005 File Tree Path Resolution Cleanup Plan

Scope: `frontend/src/components/file-tree/FileTreePanel.tsx` and `frontend/src/components/file-tree/file-tree-utils.ts`.

## Smell

`FileTreePanel` owns absolute-path detection, Windows extended-prefix stripping, and workspace-relative path resolution inline. Those helpers sit beside UI state, preview state, drag/drop state, context menus, and filesystem actions even though path resolution is a pure boundary policy used before IO calls.

## Behavior Locks

- POSIX workspace paths join relative file paths with `/`.
- Windows workspace paths join relative paths with `\` and normalize relative separators.
- Existing absolute POSIX, Windows drive, UNC, and extended Windows paths are returned as absolute paths.
- Extended Windows path prefixes are stripped before absolute-path classification.
- Trailing workspace separators are removed before joining relative paths.

## Cleanup Pass

1. Add focused `file-tree-utils` tests for path resolution before implementation.
2. Move absolute-path detection and workspace path resolution into `file-tree-utils.ts`.
3. Replace the inline `FileTreePanel` helper with the tested utility.
4. Keep drag/drop behavior untouched because desktop runtime verification is required before changing it.

## Non-Goals

- Do not change file-tree drag/drop behavior.
- Do not change preview layout or portal rendering.
- Do not change filesystem API calls beyond using the same resolved path values.

## Verification

- Red/green targeted Vitest for `file-tree-utils`.
- Existing truncated root-scan file-tree tests.
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
