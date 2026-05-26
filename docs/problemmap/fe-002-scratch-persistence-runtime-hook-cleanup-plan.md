# FE-002 Scratch Persistence Runtime Hook Cleanup Plan

## Scope

- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/useSessionComposerDraftScratch.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerDraftScratch.test.tsx`
- ProblemMap status and verification ledger

## Behavior Lock

- Draft scratch loading still uses `ScratchType.DRAFT_FOLLOW_UP` and the current scratch target id.
- `saveToScratch` suppresses writes without a workspace.
- `saveToScratch` suppresses truly empty drafts without an existing scratch.
- `saveToScratch` persists message, image paths, and executor profile through `updateScratch`.
- Failed scratch writes are swallowed after logging, preserving the current non-blocking behavior.
- Debounced message persistence writes the latest executor profile and attached image paths.

## Cleanup Pass

1. Add hook-level tests before editing the component.
2. Move `useScratch`, scratch ref tracking, attached image path ref tracking, `saveToScratch`, and debounced draft persistence into `useSessionComposerDraftScratch`.
3. Keep hydration/profile autosave effects in `TaskFollowUpSection.tsx` for the next bounded pass.
4. Re-run targeted hook/helper tests, the follow-up directory suite, frontend typecheck/lint, full check/lint, and `git diff --check`.

## Non-goals

- Do not change scratch hydration behavior.
- Do not change executor-profile hydration/autosave behavior.
- Do not change after-send scratch deletion semantics.
