# FE-002 Draft Hydration Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerDraft.ts`.

## Smell

- Boundary violation: draft hydration eligibility is embedded in a React effect that also mutates local message and image state.
- Missing test: loading suppression, same-scratch suppression, and new-scratch hydration are not directly locked.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: do nothing while loading, hydrate at most once per scratch id, default missing draft message/images to empty values.

## Cleanup Pass

1. Extract pure draft hydration decision logic.
2. Keep preview URL revocation and `setAttachedImages` in the component because they are side effects.
3. Reuse existing `imageAttachmentFromPath` mapping in the component.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerDraft.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
