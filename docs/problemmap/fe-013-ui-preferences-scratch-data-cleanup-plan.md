# FE-013 UI preferences scratch data cleanup plan

## Scope

- Files:
  - `frontend/src/hooks/useUiPreferencesScratch.ts`
  - `frontend/src/hooks/uiPreferencesScratchData.ts`
  - `frontend/src/hooks/uiPreferencesScratchData.test.ts`
- Smell: weak persistence boundary, missing tests, small duplicate fallback logic.
- Current issue: camelCase store state to snake_case scratch payload conversion, reverse hydration, defaulting, and legacy `file_search_repo_by_project` compatibility are embedded directly in the hook. The pure persistence contract has no direct tests.

## Behavior lock first

Add focused tests for the pure conversion contract:

- store snapshot serializes to the generated `UiPreferencesData` shape;
- scratch payload hydrates store state, including `workspace_panel_states` defaults;
- legacy `file_search_repo_by_project` falls back to the first legacy repo id only when `file_search_repo_id` is absent.

The tests should fail before implementation because the helper module does not exist yet.

## Cleanup order

1. Add the failing helper tests.
2. Move the pure conversion functions out of `useUiPreferencesScratch.ts`.
3. Replace the duplicated `Object.values` fallback with a single `find` over legacy values.
4. Keep hook timing, debounce, scratch writes, and Zustand subscription behavior unchanged.

## Verification

- `pnpm vitest run src/hooks/uiPreferencesScratchData.test.ts`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
