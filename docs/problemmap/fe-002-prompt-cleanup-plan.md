# FE-002 Prompt Enhancement Cleanup Plan

## Scope

- Continue reducing `TaskFollowUpSection` by extracting pure prompt
  enhancement request/result/error policy.
- Keep `configApi.enhancePrompt`, editor updates, loading state, and error state
  side effects in `TaskFollowUpSection` for this pass.
- Preserve current semantics:
  - duplicate enhance clicks are ignored while enhancement is running
  - blank local messages do not call the API
  - enhanced prompts are trimmed before applying
  - whitespace-only enhanced results are treated as
    `Prompt enhancement returned empty content`
  - known backend/OpenCode errors map to the existing user-facing messages

## Behavior Locks

- Add pure unit coverage for:
  - request payload construction with null session/workspace fallbacks
  - enhanced prompt trim behavior
  - empty enhanced prompt rejection
  - backend prefix stripping for unknown errors
  - known prompt enhancement error mapping

## Cleanup Pass

1. Add `frontend/src/components/tasks/follow-up/sessionComposerPromptEnhancement.ts`.
2. Move pure prompt enhancement helpers out of `TaskFollowUpSection.tsx`.
3. Keep `TaskFollowUpSection.tsx` responsible only for side effects.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerPromptEnhancement.test.ts`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
