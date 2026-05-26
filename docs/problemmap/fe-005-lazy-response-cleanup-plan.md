# FE-005 File Tree Lazy Response Cleanup Plan

Scope: `frontend/src/components/file-tree/FileTreePanel.tsx` and `frontend/src/components/file-tree/file-tree-utils.ts`.

## Smell

`FileTreePanel` normalizes lazy directory API responses inline inside the async load branch. The repeated `Array.isArray` guards are pure response-boundary policy, but they are embedded between loading-state mutation, API IO, error handling, and state merges.

## Behavior Locks

- Valid file, directory, gitignored file, and gitignored directory arrays pass through unchanged.
- Missing or non-array response fields normalize to empty arrays.
- The component still lazy-loads truncated root directories after the helper extraction.

## Cleanup Pass

1. Extend `file-tree-utils.test.ts` with response normalization tests before implementation.
2. Add a pure `normalizeDirectoryChildrenResponse` helper.
3. Replace inline `Array.isArray` guards in `FileTreePanel`.
4. Keep state mutation ordering and API call behavior unchanged.

## Non-Goals

- Do not change lazy-load retry/error UI.
- Do not change refresh-token reload behavior.
- Do not change drag/drop or file move behavior.

## Verification

- Red/green targeted Vitest for `file-tree-utils`.
- Existing truncated root-scan file-tree tests.
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
