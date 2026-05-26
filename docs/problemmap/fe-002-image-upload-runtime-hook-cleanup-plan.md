# FE-002 Image Upload Runtime Hook Cleanup Plan

## Scope

- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/useSessionComposerImageUpload.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerImageUpload.test.tsx`
- `frontend/src/components/tasks/follow-up/sessionComposerImages.ts`
- ProblemMap status and verification ledger

## Behavior Lock

- Missing workspace suppresses image uploads.
- Successful upload calls `imagesApi.uploadForAttempt` with the current workspace and file.
- Queued composer state is read from the queue-status query cache before applying an uploaded image.
- Uploading while a queued message exists cancels the queue, restores the queued message into the editor, and saves scratch with the queued message plus merged image paths.
- Duplicate uploaded image paths replace the previous attachment and revoke only the replaced preview URL.

## Cleanup Pass

1. Add a hook-level behavior lock for image upload runtime side effects.
2. Extract the upload loop from `TaskFollowUpSection.tsx` into `useSessionComposerImageUpload`.
3. Share preview URL revocation through the image helper boundary instead of keeping ad hoc component-local revocation.
4. Re-run targeted hook/helper tests, the follow-up directory suite, frontend typecheck/lint, full check/lint, and `git diff --check`.

## Non-goals

- Do not change scratch persistence semantics.
- Do not change image attachment ordering or duplicate replacement rules.
- Do not move unrelated scratch hydration, editor-change, or compact-context side effects in this pass.
