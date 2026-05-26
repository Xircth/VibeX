# FE-003 Emit Add-Type Cleanup Plan

## Problem

`useConversationHistory.ts` decides whether an emitted entry batch should be
tagged as `plan` by inspecting the last flattened entry inside the same callback
that writes token usage, runtime cache state, and calls `onEntriesUpdated`.
That classification is pure display policy and should be directly testable.

## Behavior To Preserve

- If the last emitted entry is a normalized `tool_use` for `ExitPlanMode`, the
  add type becomes `plan`.
- Empty entry batches keep their requested add type.
- Non-ExitPlanMode entries keep their requested add type.
- The rule applies regardless of the requested add type, matching the existing
  hook behavior.

## Cleanup Pass

1. Extract add-type derivation into `conversationEmitAddType.ts`.
2. Keep `useConversationHistory.ts` as the owner of `onEntriesUpdated`.
3. Add direct tests for empty, non-plan, and plan-ending entry batches.

## Verification

- `pnpm vitest run src/hooks/useConversationHistory/conversationEmitAddType.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory/useConversationHistory.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
