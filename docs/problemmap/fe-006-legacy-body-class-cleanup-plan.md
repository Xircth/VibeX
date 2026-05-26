# FE-006 Legacy Body Class Cleanup Plan

## Scope

- Move the `legacy-design` body class side effect out of `App.tsx` into a focused hook.
- Preserve current behavior: add the class on mount and remove it on unmount.
- Keep `LegacyDesignScope` rendering unchanged.

## Behavior Lock

- Add a hook test for mount/unmount body class mutation before editing `App.tsx`.

## Cleanup Steps

1. Add a failing test for the missing `useLegacyDesignBodyClass` hook.
2. Implement the hook.
3. Replace the inline `useEffect` in `MainAppContent`.
4. Run targeted test, frontend checks, full checks, lint, and whitespace check.

## Non-Goals

- Do not change CSS class names.
- Do not change design scope components.
- Do not remove legacy routes in this pass.
