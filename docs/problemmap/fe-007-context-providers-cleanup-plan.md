# FE-007 Context Providers Cleanup Plan

Scope: `frontend/src/components/ui/wysiwyg.tsx` and a new context provider wrapper under `frontend/src/components/ui/wysiwyg/`.

## Smell

`WYSIWYGEditor` still owns three nested app-context providers directly inside the editor shell. The provider stack is stable plumbing for task attempt id, task id, and local image metadata, but it obscures the Lexical shell and makes the wrapper harder to scan.

## Behavior Locks

- Task attempt id is exposed through `useTaskAttemptId`.
- Task id is exposed through `useTaskId`.
- Local images are exposed through `useLocalImages`.
- Missing `localImages` still provides the existing empty-array default.

## Cleanup Pass

1. Add `editor-context-providers.test.tsx` before implementation.
2. Extract `WysiwygEditorContextProviders` into `editor-context-providers.tsx`.
3. Replace the inline provider nesting in `wysiwyg.tsx`.
4. Remove direct provider imports from `wysiwyg.tsx`, keeping only the local image type import needed by public props.

## Non-Goals

- Do not change the context definitions or hooks.
- Do not move the Lexical composer shell in this pass.
- Do not change image node rendering behavior.

## Verification

- Red/green targeted Vitest for the provider wrapper and existing FE-007 policy/group tests.
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
