# FE-007 Editor Shell Cleanup Plan

Scope: `frontend/src/components/ui/wysiwyg.tsx` and a new editor shell component under `frontend/src/components/ui/wysiwyg/`.

## Smell

After extracting policy, plugin groups, context providers, insertion, and drop runtime hooks, `WYSIWYGEditor` still directly assembles the Lexical editor shell. It mixes wrapper state/copy actions with composer configuration, markdown sync, content-editable wiring, core plugins, toolbars, and editable/read-only plugin groups.

## Behavior Locks

- The shell keeps the drop-zone attributes and session-input-minimal class.
- `LexicalComposer` receives the provided `initialConfig`.
- `MarkdownSyncPlugin` receives value/change/state/editable/transformer props.
- Floating and static toolbars remain gated by disabled/show flags.
- `ContentEditable` keeps aria labels, className, drag capture propagation stops, and drag/drop handlers.
- List, table, and code-highlight plugins always render.
- Editable plugin group renders only when editable; read-only plugin group renders only when disabled.

## Cleanup Pass

1. Add `editor-shell.test.tsx` before implementation using mocked Lexical/plugin components.
2. Extract `WysiwygEditorShell` and move `EditorRefPlugin` into that shell module.
3. Replace the inline `editorContent` JSX in `wysiwyg.tsx` with `WysiwygEditorShell`.
4. Remove no-longer-needed Lexical shell/plugin imports from `wysiwyg.tsx`.

## Non-Goals

- Do not change wrapper props, copy actions, or read-only action wrapping.
- Do not change markdown sync behavior or individual plugin implementations.
- Do not change drop/insertion policies or runtime hooks.

## Verification

- Red/green targeted Vitest for the shell and existing FE-007 policy/group tests.
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
