# FE-002 Queue State Cleanup Plan

## Scope

- Continue reducing `TaskFollowUpSection` by extracting pure queue-state policy
  used by editor changes, image attachment, queued-message display, and refresh
  effects.
- Keep `queryClient`, queue/cancel mutations, image upload, local React state,
  and scratch writes in `TaskFollowUpSection` for this pass.
- Preserve current semantics:
  - queued status exposes its queued message, empty/undefined status does not
  - visible queued message appears only while the attempt is running
  - attaching an image while a message is queued cancels the queued message,
    uses the queued text as the scratch/editor base, and carries queued image
    paths forward
  - queue status refreshes when the attempt is not running, or when a running
    attempt gets a new process

## Behavior Locks

- Add pure unit coverage for:
  - queue status snapshot extraction
  - visible queued-message gating
  - image-attach seed derivation from queued vs empty state
  - process-count refresh policy

## Cleanup Pass

1. Add `frontend/src/components/tasks/follow-up/sessionComposerQueue.ts`.
2. Move pure queue-state helpers out of `TaskFollowUpSection.tsx`.
3. Keep `TaskFollowUpSection.tsx` responsible only for side effects.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerQueue.test.ts`
- FE-002 combined helper tests
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
