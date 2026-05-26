# FE-006 Route Table Cleanup Plan

## Scope

- `frontend/src/App.tsx`
- new app route-table component and focused route rendering tests

## Behavior Lock

- Add route tests before extraction with `MemoryRouter` and mocked page/layout components for:
  - root and `/local-projects/:projectId` render through the standard legacy layout
  - workspace/session routes render through the IDE workspace layout
  - `/settings` redirects to `/settings/agents`
  - `/mcp-servers` redirects to `/settings/mcp`
  - disabled `/workspaces/*` and `/projects/*` routes redirect to `/local-projects`
  - full attempt logs route stays outside the IDE/standard layout groups

## Smells

- Boundary violation: `App.tsx` still owns the full route table plus shell effects, global providers, and window-specific entrypoints.
- Weak testability: redirect behavior and layout grouping are only reviewable by reading JSX inside the app root.
- Historical baggage: disabled new UI redirects are mixed with ordinary route declarations.

## Pass Order

1. Add route-table regression tests that fail before the component exists.
2. Move the existing route tree and `MainLegacyScope` into a dedicated `MainAppRoutes` component.
3. Replace the inline `<Routes>` block in `MainAppContent` with `<MainAppRoutes />`.
4. Run route tests, frontend checks, full checks, lint, and whitespace validation.

## Non-Goals

- Do not add, remove, or reorder routes.
- Do not change layout wrappers or provider placement.
- Do not change route paths, redirect destinations, or `replace` behavior.
