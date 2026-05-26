# FE-007 Read-Only Plugins Cleanup Plan

Scope: `frontend/src/components/ui/wysiwyg.tsx` and a new read-only plugin group under `frontend/src/components/ui/wysiwyg/`.

## Smell

`WYSIWYGEditor` still mixes mode-specific plugin rendering with editor shell assembly. The read-only branch is small but important: link sanitization is always required, while clickable inline code is conditional on both a path matcher and click handler.

## Behavior Locks

- Read-only link sanitization plugin always renders in the read-only plugin group.
- Clickable code plugin does not render with missing matcher or missing click handler.
- Clickable code plugin receives the exact matcher and click handler when both are provided.

## Cleanup Pass

1. Add `read-only-plugins.test.tsx` before implementation.
2. Extract `WysiwygReadOnlyPlugins` into `read-only-plugins.tsx`.
3. Replace the inline disabled-mode plugin JSX in `wysiwyg.tsx` with the grouped component.
4. Remove direct read-only plugin imports from `wysiwyg.tsx`.

## Non-Goals

- Do not change editable plugin rendering in this pass.
- Do not change read-only action buttons.
- Do not change link or clickable-code plugin internals.

## Verification

- Red/green targeted Vitest for the new read-only plugin group and existing FE-007 policy tests.
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
