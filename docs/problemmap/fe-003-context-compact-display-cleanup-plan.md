# FE-003 Context Compact Display Cleanup Plan

## Problem

`useConversationHistory.ts` handles context compact prompts inside the
coding-agent flattening branch. That logic is display policy: detect `/compact`,
choose system vs error status entry, build a synthetic patch key, and report
running/failed flags back to the next-action logic. Keeping it inline makes the
remaining coding-agent flattening branch harder to audit.

## Behavior To Preserve

- Non-compact prompts return no synthetic context compact entry.
- Running compact prompts emit the existing running text as a system message.
- Completed/undefined compact statuses emit the existing success text as a
  system message.
- Failed/killed compact statuses emit the existing failed text as an error
  message with `error_type: other`.
- The synthetic patch key remains `<processId>:context-compact`.

## Cleanup Pass

1. Extract context compact display entry construction into
   `conversationContextCompactDisplay.ts`.
2. Return both the generated display entry and process-state flags needed by the
   flattening callback.
3. Keep final next-action decisions and live-process lookup inside
   `useConversationHistory.ts`.

## Verification

- `pnpm vitest run src/hooks/useConversationHistory/conversationContextCompactDisplay.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory/useConversationHistory.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
