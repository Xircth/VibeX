# FE-018 WYSIWYG decorator-node type-boundary cleanup plan

## Scope

- Files:
  - `frontend/src/components/ui/wysiwyg/lib/create-decorator-node.tsx`
  - `frontend/src/components/ui/wysiwyg/lib/create-decorator-node.test.tsx`
  - `docs/problemmap/frontend.md`
  - `docs/problemmap/README.md`
- Smell: weak type boundary, duplicated casts.
- Current issue: generated decorator-node transformers receive an `isNode` predicate, but the helper types it as a boolean function and then repeats `(node as unknown as { getData(): T }).getData()` in both inline and fenced export paths.

## Behavior lock first

Add focused transformer export tests for the factory:

- inline transformer exports serialized node data;
- inline transformer returns `null` for non-generated nodes;
- fenced transformer wraps serialized node data in the expected fenced block.

## Cleanup order

1. Add the transformer export tests against current behavior.
2. Retype transformer helpers so `isNode` remains a type predicate.
3. Replace repeated `unknown` casts with direct `node.getData()` after narrowing.
4. Search for remaining casts in the factory.

## Verification

- `pnpm vitest run src/components/ui/wysiwyg/lib/create-decorator-node.test.tsx`
- `rg -n "as unknown as \\{ getData\\(\\): T \\}" frontend/src/components/ui/wysiwyg/lib/create-decorator-node.tsx`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
