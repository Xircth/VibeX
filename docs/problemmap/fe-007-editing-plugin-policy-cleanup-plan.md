# FE-007 Editing Plugin Policy Cleanup Plan

## Scope

- `frontend/src/components/ui/wysiwyg.tsx`
- new pure editing-plugin policy helper and tests

## Behavior Lock

- Add tests before implementation for:
  - disabled editors enable no editing plugins
  - default editable preset enables markdown helpers, code block shortcut, typeahead, keyboard commands, and image keyboard
  - session-input-minimal disables markdown helpers and code block shortcut while keeping typeahead, keyboard commands, and image keyboard
  - slash command typeahead requires an executor profile
  - dollar command typeahead requires a Codex executor profile
  - clicked element insert requires a registered insert callback
  - autofocus only follows `autoFocus` in editable mode

## Smells

- Weak boundary: editing plugin selection policy is embedded in `WYSIWYGEditor` JSX.
- Complex implementation: plugin rules are interleaved with Lexical composer setup, content rendering, contexts, and read-only behavior.
- Missing tests: profile/preset-driven plugin decisions are not directly locked.

## Pass Order

1. Add red tests for plugin selection policy.
2. Extract policy into a kebab-case helper under `components/ui/wysiwyg`.
3. Replace inline boolean checks in `wysiwyg.tsx` with the tested policy object.
4. Run targeted tests, frontend checks, full checks, lint, and whitespace validation.

## Non-Goals

- Do not move the plugin JSX tree in this pass.
- Do not change plugin ordering, props, providers, or Lexical context behavior.
- Do not change drag/drop intake.
