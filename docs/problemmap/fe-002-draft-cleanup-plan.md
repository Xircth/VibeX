# FE-002 Draft Cleanup Plan

## Scope

- Continue reducing `TaskFollowUpSection` by extracting draft follow-up data
  normalization and scratch payload construction.
- Keep React state, `useScratch`, debouncing, queue mutation, send flow, and
  image upload side effects in `TaskFollowUpSection` for this pass.
- Preserve the existing legacy draft compatibility:
  - current `executor_config`
  - older `executor_profile_id`
  - older `model_id` alias for `model`

## Behavior Locks

- Add pure unit coverage for:
  - DRAFT_FOLLOW_UP payload extraction from scratch values
  - legacy executor profile normalization
  - empty-draft persistence skip policy
  - scratch update payload construction
  - draft image attachment hydration from stored paths

## Cleanup Pass

1. Add `frontend/src/components/tasks/follow-up/sessionComposerDraft.ts`.
2. Move pure draft functions out of `TaskFollowUpSection.tsx`.
3. Keep `TaskFollowUpSection.tsx` responsible only for when to call
   `updateScratch`/`deleteScratch`, not how to shape draft data.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerDraft.test.ts`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
