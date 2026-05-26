# FE-002 Composer Cleanup Plan

## Scope

- Continue reducing `TaskFollowUpSection` and `SessionComposerInput` without
  touching send, queue, scratch, image upload, or prompt-enhancement side
  effects in this pass.
- Keep the pass limited to session-composer typeahead option derivation.

## Behavior Locks

- Extend `sessionComposerTypeahead.test.ts` to cover:
  - slash command matching and command-before-skill ordering
  - dollar command matching
  - tag/file search result option mapping
  - root file/directory option limiting for empty `@` queries

## Cleanup Pass

1. Extract pure typeahead option derivation from
   `SessionComposerInput.tsx` into `sessionComposerTypeaheadOptions.ts`.
2. Keep React query orchestration, menu state, keyboard handling, and portal
   rendering in `SessionComposerInput.tsx`.
3. Keep the public `SessionComposerInput` props unchanged.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerTypeahead.test.ts`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`

