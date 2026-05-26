# FE-007 Read-Only Actions Cleanup Plan

## Scope

- `frontend/src/components/ui/wysiwyg.tsx`
- new focused read-only action row component and tests

## Behavior Lock

- Add component tests before implementation for:
  - copy button label switches between `Copy as Markdown` and `Copied!`
  - copy click calls the provided handler
  - edit/delete buttons render only when callbacks are provided
  - edit/delete clicks call their callbacks

## Smells

- Complex implementation: read-only action presentation is embedded beside Lexical editor setup, drag/drop handlers, markdown policy, and plugin rendering.
- Missing tests: action-row conditional rendering and callbacks are not directly locked.
- Weak boundary: read-only controls are regular UI, not Lexical editor configuration.

## Pass Order

1. Add red tests for the standalone read-only action row.
2. Extract the action row into a small component under `components/ui/wysiwyg`.
3. Replace the inline read-only action JSX in `WYSIWYGEditor`.
4. Run targeted tests, frontend checks, full checks, lint, and whitespace validation.

## Non-Goals

- Do not change copy behavior, clipboard handling, hover visibility classes, labels, icons, or read-only editor rendering.
- Do not change edit/delete callback contracts.
