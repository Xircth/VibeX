# FE-007 Editor Config Cleanup Plan

Scope: `frontend/src/components/ui/wysiwyg.tsx` and a new tested editor-config helper under `frontend/src/components/ui/wysiwyg/`.

## Smell

`WYSIWYGEditor` still owns the Lexical composer `initialConfig` object inline. That object combines stable editor identity, error handling, theme class policy, and node registration with React refs, drag/drop handlers, plugin rendering, and read-only actions.

## Behavior Locks

- Default preset keeps the current namespace, `console.error` error handler, rich paragraph/text/list classes, code-highlight theme, and full node registration list.
- `session-input-minimal` keeps the current compact paragraph/heading/list classes and suppresses inline text styling where the wrapper currently does.
- Node registration preserves the current order and includes all custom nodes: image, PR comment, tag reference, slash command, dollar command, file reference, clicked element, and table nodes.

## Cleanup Pass

1. Add `editor-config-policy.test.ts` before implementation to lock both theme variants and node registration.
2. Extract `getWysiwygInitialConfig(markdownPreset)` into `editor-config-policy.ts`.
3. Replace the inline `initialConfig` block in `wysiwyg.tsx` with a memoized helper call.
4. Remove node/theme imports from `wysiwyg.tsx` that become helper-owned.

## Non-Goals

- Do not change the Lexical plugin rendering tree in this pass.
- Do not change file-reference insertion or custom drop behavior in this pass.
- Do not add dependencies or change markdown transformer behavior.

## Verification

- Red/green targeted Vitest for the new editor config helper and existing WYSIWYG policy helpers.
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
