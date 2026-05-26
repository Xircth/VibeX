# FE-012 image URL placeholder cleanup plan

## Scope

- File: `frontend/src/lib/api/misc.ts`
- Smell: dead code, stale TODO, weak API boundary.
- Current issue: `imagesApi.getImageUrl` exposes a synchronous image URL API that always returns an empty string and carries a Tauri serving TODO. No frontend caller uses it; current image preview flows use uploaded metadata, blob previews, or file-tree preview helpers instead.

## Behavior lock first

- Run `rg -n "getImageUrl\(" frontend/src` before deletion to prove the placeholder has no callers.
- After deletion, run frontend typecheck and lint to prove no internal API consumer depends on the property.

## Cleanup order

1. Delete the unused `getImageUrl` property and its stale TODO.
2. Keep upload/delete/list image APIs unchanged.
3. Update ProblemMap and verification ledger.

## Verification

- `rg -n "getImageUrl\(" frontend/src`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
