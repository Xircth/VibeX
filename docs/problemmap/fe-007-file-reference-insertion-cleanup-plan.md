# FE-007 File Reference Insertion Cleanup Plan

Scope: `frontend/src/components/ui/wysiwyg.tsx` and a new insertion helper under `frontend/src/components/ui/wysiwyg/`.

## Smell

`WYSIWYGEditor` still owns the Lexical mutation algorithm for inserting file-reference chips. That logic belongs beside the file-reference node behavior, not in the shell wrapper that also owns props, plugin composition, drag/drop events, and read-only actions.

## Behavior Locks

- Missing payload or missing editor does nothing.
- Valid payload focuses the editor before mutation.
- Range selection inserts file-reference node followed by a trailing space.
- When no range selection exists, insertion appends to the last element child when one exists.
- When no appendable last element exists, insertion creates a paragraph and appends the file-reference node plus trailing space.

## Cleanup Pass

1. Add `file-reference-insertion.test.ts` before implementation with mocked Lexical primitives.
2. Extract `insertFileReferenceIntoEditor(editor, payload)` into `file-reference-insertion.ts`.
3. Replace the inline insertion callback body in `wysiwyg.tsx` with the helper.
4. Remove no-longer-needed Lexical mutation imports from `wysiwyg.tsx`.

## Non-Goals

- Do not change drag/drop payload parsing or disabled-mode rules.
- Do not change the `FileReferenceNode` implementation.
- Do not alter text spacing behavior after insertion.

## Verification

- Red/green targeted Vitest for the insertion helper and existing FE-007 policy/group tests.
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
