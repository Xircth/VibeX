# FE-017 unused file type icon module cleanup plan

## Scope

- Files:
  - `frontend/src/utils/fileTypeIcon.ts`
  - `docs/problemmap/frontend.md`
  - `docs/problemmap/README.md`
- Smell: dead code, weak type boundary.
- Current issue: `frontend/src/utils/fileTypeIcon.ts` defines a Lucide-based file-icon mapping and adapts icons through `as unknown as`, but `rg` finds no imports of the module. The active file icon path is `frontend/src/utils/fileIcons.ts` through `frontend/src/components/FileIcon.tsx`.

## Behavior lock first

- Prove no runtime caller uses the module with `rg -n "fileTypeIcon|@/utils/fileTypeIcon|../utils/fileTypeIcon|utils/fileTypeIcon" frontend/src`.
- Use frontend and repo typecheck/lint after deletion to prove no internal import or declaration dependency remains.

## Cleanup order

1. Run the import search before deletion.
2. Delete the unused module.
3. Re-run import search and full gates.

## Verification

- `rg -n "fileTypeIcon|@/utils/fileTypeIcon|../utils/fileTypeIcon|utils/fileTypeIcon" frontend/src`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
