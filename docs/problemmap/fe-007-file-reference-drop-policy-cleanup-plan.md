# FE-007 File Reference Drop Policy Cleanup Plan

## Scope

- `frontend/src/components/ui/wysiwyg.tsx`
- new pure file-reference drop policy helper and tests

## Behavior Lock

- Add tests before implementation for:
  - disabled editors reject dragover/drop/custom-drop intake
  - dragover accepts either the file-reference MIME type or the app-managed current drag payload
  - drop prefers the serialized data-transfer payload when it is valid
  - drop falls back to the app-managed current drag payload when serialized data is missing or invalid
  - drop ignores unrelated payloads
  - custom drop returns its detail only in editable mode

## Smells

- Weak boundary: WYSIWYG currently mixes drag/drop event mechanics with payload selection policy.
- Complex implementation: file-reference intake is interleaved with Lexical insertion and editor rendering.
- Missing tests: MIME vs app-managed fallback behavior is not directly locked.

## Pass Order

1. Add red tests for file-reference drop policy.
2. Extract policy into a kebab-case helper under `components/ui/wysiwyg`.
3. Replace inline policy branches in `wysiwyg.tsx` while keeping event handling, insertion, and cleanup side effects in place.
4. Run targeted tests, frontend checks, full checks, lint, and whitespace validation.

## Non-Goals

- Do not change the custom event name, data attributes, inserted Lexical nodes, spacing after inserted file chips, or global drag-state cleanup.
- Do not change file-tree dispatch behavior in this pass.
