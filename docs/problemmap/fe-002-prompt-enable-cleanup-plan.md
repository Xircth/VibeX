# FE-002 Prompt Enhancement Enablement Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and `frontend/src/components/tasks/follow-up/sessionComposerPromptEnhancement.ts`.

## Smell

- Boundary violation: prompt enhancement enablement is still derived inline in the component, separate from the tested prompt enhancement start decision.
- Missing test: disabled typing and whitespace-only drafts are not locked at the button-enable policy boundary.

## Behavior Lock

- Add focused helper coverage before editing the component.
- Preserve existing behavior: prompt enhancement is available only when follow-up typing is allowed and the draft contains non-whitespace text.

## Cleanup Pass

1. Extract pure prompt enhancement enablement derivation.
2. Keep UI state and action execution in the component.
3. Reuse the tested helper from the existing prompt enhancement boundary.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerPromptEnhancement.test.ts`
- FE-002 helper test batch
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
