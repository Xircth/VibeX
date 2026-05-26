# FE-014 MCP strategy path traversal cleanup plan

## Scope

- File: `frontend/src/lib/mcpStrategies.ts`
- Smell: duplication, weak config boundary, missing tests.
- Current issue: MCP config strategy methods each hand-roll JSON cloning, path traversal, object creation, missing-path errors, and preconfigured-server insertion. This duplicates the same config-path boundary across create/validate/extract/add flows.

## Behavior lock first

Add focused unit coverage for the public strategy behavior before refactoring:

- `createFullConfig` writes servers at a nested path and replaces non-object intermediate values;
- `validateFullConfig` / `extractServersForApi` preserve missing-path and non-object-server errors;
- `addPreconfiguredToConfig` preserves the existing empty-path root insertion behavior.

These tests should pass before cleanup, proving the refactor preserves current frontend semantics.

## Cleanup order

1. Add strategy behavior tests.
2. Extract shared JSON object cloning, path label, path read, and object-path creation helpers.
3. Route create/validate/extract/add through the helpers.
4. Preserve empty-path semantics; do not align them with backend rejection in this cleanup slice.

## Verification

- `pnpm vitest run src/lib/mcpStrategies.test.ts`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
