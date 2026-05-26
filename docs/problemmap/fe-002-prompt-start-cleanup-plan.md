# FE-002 Prompt Enhancement Start Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerPromptEnhancement.ts`.

## Smell

- Boundary violation: prompt enhancement start gating is embedded inside the async handler that also mutates UI state and calls the backend.
- Missing test: busy-state suppression and empty-draft suppression are not directly locked.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: do not start while enhancement is already running, and do not start for whitespace-only drafts.

## Cleanup Pass

1. Extract pure prompt enhancement start decision logic.
2. Keep `setIsEnhancingPrompt`, error clearing, backend calls, and result application in the component.
3. Avoid changing the request payload or error mapping behavior.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerPromptEnhancement.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
