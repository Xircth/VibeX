# FE-006 Main Window Close Behavior Cleanup Plan

## Scope

- Move main-window close behavior storage and execution helpers out of `App.tsx`.
- Preserve the existing localStorage key and accepted values: `exit` and `minimize`.
- Keep the close-choice toast UI in `App.tsx`.

## Behavior Lock

- Add tests for saved close behavior parsing, invalid-value suppression, and behavior persistence.

## Cleanup Steps

1. Add a failing test for the missing close behavior helper.
2. Move helper functions into `mainWindowCloseBehavior.ts`.
3. Import the helpers in `App.tsx` and remove the local copies/imports.
4. Run targeted tests, frontend checks, full checks, lint, and whitespace check.

## Non-Goals

- Do not change the close-choice dialog UI.
- Do not change the Tauri minimize or app-exit calls.
- Do not change the remember-checkbox default.
