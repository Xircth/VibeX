# FE-002 Editability Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerSubmit.ts`.

## Smell

- Boundary violation: composer editability is derived inline in the component while related typing/send/compact gates already live in the submit helper.
- Missing test: retry-active and pending-approval edit locks are only indirectly covered through broader typing gates.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: the composer is editable only when no retry is active and no tool approval is pending.

## Cleanup Pass

1. Extract pure editability derivation into the submit helper.
2. Keep the component as the side-effect/render owner.
3. Reuse the extracted gate wherever the component needs `isEditable`.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerSubmit.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
