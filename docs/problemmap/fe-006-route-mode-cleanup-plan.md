# FE-006 Route Mode Cleanup Plan

## Scope

- Extract top-level shell route mode selection from `App.tsx` into a pure helper.
- Preserve current exact-match behavior for `/desktop-toast` and `/project-rail`.
- Keep route rendering and providers in `App.tsx`.

## Behavior Lock

- Add tests for desktop toast route, project rail route, similarly prefixed non-matching routes, and default main-app routes.

## Cleanup Steps

1. Add a failing test for the route mode helper.
2. Implement `appRouteMode.ts`.
3. Replace inline pathname comparisons in `AppContent`.
4. Run targeted tests, frontend checks, full checks, lint, and whitespace check.

## Non-Goals

- Do not refactor the full route table in this pass.
- Do not change provider composition.
- Do not change legacy design scope behavior.
