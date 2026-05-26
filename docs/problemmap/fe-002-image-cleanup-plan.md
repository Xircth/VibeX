# FE-002 Image Cleanup Plan

## Scope

- Continue reducing `TaskFollowUpSection` by extracting pure composer image
  attachment derivation and merge policy.
- Keep file upload, object URL creation, queue cancellation, state updates, and
  scratch persistence in `TaskFollowUpSection` for this pass.
- Preserve current semantics:
  - queued image paths are restored before current local attachments
  - attachments are deduped by final image path
  - a new upload replaces an existing attachment with the same path
  - replaced preview URLs are revoked only when they differ from the new preview

## Behavior Locks

- Add pure unit coverage for:
  - stored image path hydration
  - uploaded image response conversion to composer attachment
  - queued/current/new attachment merge ordering
  - duplicate path replacement
  - replacement preview revocation selection

## Cleanup Pass

1. Add `frontend/src/components/tasks/follow-up/sessionComposerImages.ts`.
2. Move image attachment helpers out of `TaskFollowUpSection.tsx` and out of
   the draft helper.
3. Keep `TaskFollowUpSection.tsx` responsible only for side effects.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerImages.test.ts`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
