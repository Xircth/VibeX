# FE-005 File Preview Snippet Cleanup Plan

Scope: `frontend/src/components/file-tree/FileTreePanel.tsx` and `frontend/src/components/file-tree/file-tree-utils.ts`.

## Smell

`FileTreePanel` builds selected preview snippets inline inside `handleAddSelection`: line slicing, one-based range labels, language fence selection, and final markdown formatting are pure presentation policy but sit inside component callback wiring.

## Behavior Locks

- Single-line selections produce `path:Lx` labels.
- Multi-line selections produce `path:Lx-Ly` labels.
- Known file extensions include the language in the markdown fence.
- Unknown file extensions use a plain markdown fence.
- Selected content preserves embedded newlines.

## Cleanup Pass

1. Extend `file-tree-utils.test.ts` with preview snippet tests before implementation.
2. Add a pure `buildFilePreviewSelectionSnippet` helper.
3. Replace inline snippet construction in `FileTreePanel`.
4. Keep selection state and popover UI untouched.

## Non-Goals

- Do not change preview selection interaction.
- Do not change preview fetch behavior.
- Do not change drag/drop behavior.

## Verification

- Red/green targeted Vitest for `file-tree-utils`.
- Existing truncated root-scan file-tree tests.
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
