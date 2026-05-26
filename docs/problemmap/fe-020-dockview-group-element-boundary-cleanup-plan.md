# FE-020 Dockview Group Element Boundary Cleanup Plan

## Scope

- `frontend/src/utils/dockviewGroupPolicy.ts`
- `frontend/src/utils/dockviewGroupPolicy.test.ts`
- ProblemMap index entries for this pass

## Problem

`getGroupElement` currently casts a `DockviewGroupLike` through `unknown` to read
the Dockview runtime `element` property. The surrounding helper already owns the
minimal group shape used by panel placement and header hiding policy, so the cast
hides a real boundary capability instead of documenting it in the local type.

## Behavior Lock

- Run `pnpm vitest run src/utils/dockviewGroupPolicy.test.ts` before the edit.
- Existing coverage locks group classification, placeholder split exclusion,
  editor-group ordering by DOM rect, id fallback ordering, and next editor group
  id selection.

## Cleanup Pass

1. Add the optional `element?: HTMLElement` capability to the local
   `DockviewGroupLike` boundary type.
2. Replace the `unknown` cast in `getGroupElement` with direct optional access.
3. Avoid touching Dockview placement behavior, group classification, or panel
   movement policy.

## Verification

- `pnpm vitest run src/utils/dockviewGroupPolicy.test.ts`
- `rg -n "group as unknown as \\{ element\\?: HTMLElement \\}" frontend/src/utils/dockviewGroupPolicy.ts`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
