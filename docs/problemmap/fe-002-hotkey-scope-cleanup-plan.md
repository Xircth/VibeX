# FE-002 Hotkey Scope Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and a new focused helper under `frontend/src/components/tasks/follow-up/`.

## Smell

- Duplication: `FOLLOW_UP` and `FOLLOW_UP_READY` scope effects repeat the same editable/focus activation condition.
- Weak boundary: hotkey scope eligibility is coupled to effect bodies instead of a named composer policy.
- Missing test: readonly and unfocused scope states are not directly locked outside React.

## Behavior Lock

- Add a focused helper test before editing the component.
- Cover editable + focused activation, readonly suppression, and unfocused suppression.

## Cleanup Pass

1. Extract pure hotkey-scope activation derivation.
2. Keep the component effects as the only place that calls `enableScope` and `disableScope`.
3. Preserve existing cleanup behavior: each effect disables its own scope on teardown.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerHotkeys.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
