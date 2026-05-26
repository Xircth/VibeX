# FE-007 Editable Plugins Cleanup Plan

Scope: `frontend/src/components/ui/wysiwyg.tsx` and a new editable plugin group under `frontend/src/components/ui/wysiwyg/`.

## Smell

The editable-mode plugin tree remains embedded in `WYSIWYGEditor`. It mixes plugin grouping, policy checks, typeahead providers, executor-specific command plugins, keyboard command props, image shortcuts, code-block shortcuts, and clicked-element insertion with the editor shell.

## Behavior Locks

- History plugin renders for editable mode.
- Autofocus, markdown helpers, typeahead group, keyboard commands, image keyboard, code-block shortcut, and clicked-element insertion honor `WysiwygEditingPluginPolicy`.
- Slash command typeahead still requires both policy enablement and an executor profile.
- Dollar command typeahead is controlled by policy.
- Keyboard commands receive active transformers, callbacks, and send shortcut.

## Cleanup Pass

1. Add `editable-plugins.test.tsx` before implementation with mocked plugin components.
2. Extract `WysiwygEditablePlugins` into `editable-plugins.tsx`.
3. Replace inline editable plugin JSX in `wysiwyg.tsx` with the grouped component.
4. Remove direct editable plugin imports from `wysiwyg.tsx`.

## Non-Goals

- Do not change plugin internals or command behavior.
- Do not change `getWysiwygEditingPluginPolicy`.
- Do not move `MarkdownSyncPlugin`, core List/Table/CodeHighlight plugins, or the content editable shell in this pass.

## Verification

- Red/green targeted Vitest for the editable plugin group and existing FE-007 policy tests.
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
