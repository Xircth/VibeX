# FE-007 Transformer Policy Cleanup Plan

## Scope

- `frontend/src/components/ui/wysiwyg.tsx`
- new WYSIWYG markdown preset policy helper and focused tests

## Behavior Lock

- Add regression tests before implementation for:
  - default preset includes table/image/PR/tag/slash/dollar/file/clicked-element transformers, code block support, and Lexical default transformers
  - default shortcut transformers keep the active default transformer set but remove heading shortcuts
  - session-input-minimal preset includes only the structured chip/image transformers used by composer input
  - session-input-minimal shortcut transformers are empty

## Smells

- Weak boundary: markdown preset policy is pure editor configuration but lives inside the React component.
- Complex implementation: `WYSIWYGEditor` interleaves transformer selection with refs, drag/drop handlers, context providers, and plugin rendering.
- Missing tests: preset transformer differences are not directly locked, so later plugin changes can silently alter composer markdown behavior.

## Pass Order

1. Add red tests for markdown preset transformer and shortcut selection.
2. Extract the transformer policy into a dedicated helper under `components/ui/wysiwyg`.
3. Replace the inline `useMemo` transformer lists in `wysiwyg.tsx` with the tested helper.
4. Run targeted WYSIWYG tests, frontend checks, full checks, lint, and whitespace validation.

## Non-Goals

- Do not alter the order of active transformers.
- Do not change Lexical node registration, theme classes, plugin rendering, drag/drop behavior, or read-only actions in this pass.
