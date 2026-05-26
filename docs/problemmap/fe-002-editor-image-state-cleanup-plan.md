# FE-002 Editor/Image State Cleanup Plan

## Scope

- Continue reducing `TaskFollowUpSection` by extracting pure state-transition
  policy for editor changes and image removal/clearing.
- Keep queue mutation, scratch writes, `URL.revokeObjectURL`, and React state
  setters in `TaskFollowUpSection` for this pass.
- Preserve current semantics:
  - editing while a queued message exists cancels the queued message
  - editing clears the visible follow-up error only when one exists
  - removing an image removes every attachment with the matching id, revokes
    the removed previews, and persists the remaining image paths
  - clearing composer images revokes all previous previews and leaves no
    attachments

## Behavior Locks

- Add pure unit coverage for:
  - editor change side-effect decisions from queue/error state
  - image removal returning remaining attachments and revocation candidates
  - image clearing returning no attachments and all revocation candidates

## Cleanup Pass

1. Extend `sessionComposerQueue.ts` with editor change side-effect policy.
2. Extend `sessionComposerImages.ts` with remove/clear attachment policy.
3. Replace inline component state-transition branches with the tested helpers.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerQueue.test.ts`
- `pnpm vitest run src/components/tasks/follow-up/sessionComposerImages.test.ts`
- FE-002 combined helper tests
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
