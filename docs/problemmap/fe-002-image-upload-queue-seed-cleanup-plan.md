# FE-002 Image Upload Queue Seed Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx`, `frontend/src/components/tasks/follow-up/sessionComposerImages.ts`, and existing image helper tests.

## Smell

- Duplication: image upload handling derives queue seed data in the component and again inside `getUploadedImageApplication`.
- Weak boundary: queue-cancel state, scratch seed message, queued attachments, and upload attachment merge are one decision but split across component and helper.
- Missing clarity: `TaskFollowUpSection` should orchestrate side effects only after receiving the upload application result.

## Behavior Lock

- Existing `sessionComposerImages.test.ts` already covers queued upload application:
  - queued status requests queue cancellation,
  - queued message becomes the scratch seed,
  - queued attachments are restored before current/uploaded attachments,
  - duplicate previews are selected for revocation.

## Cleanup Pass

1. Keep queue-seed and upload-application derivation in `getUploadedImageApplication`.
2. Remove direct `getAttachImageQueueSeed` use from `TaskFollowUpSection`.
3. Preserve side effects: cancel queue first, hydrate draft message from the queued seed, save the merged scratch image paths.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerImages.test.ts`
- `pnpm vitest run src/components/tasks/follow-up`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
