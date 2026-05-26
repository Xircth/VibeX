# FE-002 Prompt Enhancement Runtime Hook Cleanup Plan

## Scope

- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/useSessionComposerPromptEnhancement.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerPromptEnhancement.test.tsx`
- `docs/problemmap/frontend.md`
- `docs/problemmap/README.md`

## Smell

`TaskFollowUpSection.tsx` still owns prompt enhancement runtime side effects directly:

- enhancement busy state
- start gating
- `configApi.enhancePrompt` execution
- request construction from session/workspace/context data
- enhanced prompt normalization
- user-facing error mapping
- applying the enhanced prompt through the editor-change path

The pure request/result/error helpers already exist in `sessionComposerPromptEnhancement.ts`, but the component still wires the async runtime lifecycle inline.

## Behavior Lock

Add a hook-level regression test before extraction:

- empty drafts suppress enhancement calls
- valid drafts call `configApi.enhancePrompt` with the expected request
- successful results are normalized and applied through the provided callback
- existing follow-up errors are cleared when enhancement starts
- backend failures are mapped through the existing prompt enhancement error helper

## Cleanup Pass

1. Add `useSessionComposerPromptEnhancement` under `follow-up/`.
2. Move prompt enhancement busy state and async lifecycle out of `TaskFollowUpSection.tsx`.
3. Keep the existing `handleEditorChange` path as the application callback so queue cancellation and editor error clearing semantics remain unchanged.
4. Preserve the existing pure helpers from `sessionComposerPromptEnhancement.ts`.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/UseSessionComposerPromptEnhancement.test.tsx`
- `pnpm vitest run src/components/tasks/follow-up/sessionComposerPromptEnhancement.test.ts`
- `pnpm vitest run src/components/tasks/follow-up`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
