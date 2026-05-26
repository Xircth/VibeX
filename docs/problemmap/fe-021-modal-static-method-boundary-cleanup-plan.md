# FE-021 Modal Static Method Boundary Cleanup Plan

## Scope

- `frontend/src/lib/modals.ts`
- `frontend/src/lib/modals.test.tsx`
- ProblemMap index entries for this pass

## Problem

`defineModal` mutates a NiceModal-created component by first casting it through
`unknown` to `Modalized<P, R>`. The helper does need a small adapter because
NiceModal injects modal props at runtime, but the current double cast hides the
actual operation: attach `show`, `hide`, and `remove` static methods to the same
component value.

## Behavior Lock

- Add focused tests for `defineModal` before changing implementation.
- Lock that `defineModal` returns the original component reference.
- Lock that `show(props)` delegates to `NiceModal.show(component, props)`.
- Lock that `show()` for void-prop modals delegates with `undefined` props.
- Lock that `hide()` and `remove()` delegate to the same component reference.

## Cleanup Pass

1. Keep public `Modalized<P, R>`, `NoProps`, and result types unchanged.
2. Replace the `component as unknown as Modalized<P, R>` mutation with
   `Object.assign` over the component reference and explicit static methods.
3. Keep the narrow NiceModal component argument assertions only where the
   upstream API boundary requires them.

## Verification

- Red `pnpm vitest run src/lib/modals.test.tsx` before implementation.
- Passing `pnpm vitest run src/lib/modals.test.tsx` after implementation.
- `rg -n "as unknown as" frontend/src/lib/modals.ts`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
