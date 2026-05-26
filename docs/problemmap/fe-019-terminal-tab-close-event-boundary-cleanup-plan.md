# FE-019 terminal tab close event-boundary cleanup plan

## Scope

- Files:
  - `frontend/src/components/panels/DockviewTerminalPanel.tsx`
  - `frontend/src/components/panels/DockviewTerminalPanel.test.ts`
  - `docs/problemmap/frontend.md`
  - `docs/problemmap/README.md`
- Smell: weak UI event boundary, duplicated implicit key policy.
- Current issue: terminal tab close keyboard handling calls the mouse close handler by casting a keyboard event to `React.MouseEvent`. The handler only needs `stopPropagation`, and the Enter/Space close-key policy is embedded inline.

## Behavior lock first

Add a focused unit test for the close-key policy:

- Enter activates close;
- Space activates close;
- other keys do not activate close.

## Cleanup order

1. Add the pure close-key policy test.
2. Export and use a typed `isTerminalTabCloseKey` helper.
3. Widen the close handler event type to the event capability it actually needs, removing the keyboard-to-mouse cast.
4. Re-run targeted and full gates.

## Verification

- `pnpm vitest run src/components/panels/DockviewTerminalPanel.test.ts`
- `rg -n "event as unknown as React.MouseEvent" frontend/src/components/panels/DockviewTerminalPanel.tsx`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
