# FE-003 Token Usage Cleanup Plan

## Problem

`useConversationHistory.ts` emits entries and also scans the displayed process
store for the latest token usage entry. The scan is pure ordering logic, but it
is embedded in the React callback that writes context state and not directly
covered outside broad hook tests.

## Behavior To Preserve

- Processes are ordered by `executionProcess.created_at`.
- The latest process wins over older processes.
- Within the latest matching process, the last token usage entry wins.
- A store with no token usage entries returns `null`.

## Cleanup Pass

1. Extract token usage derivation into `conversationTokenUsage.ts`.
2. Keep `useConversationHistory.ts` as the owner of `setTokenUsageInfo`.
3. Add direct unit tests for process ordering, per-process reverse scanning, and
   the no-token case.

## Verification

- `pnpm vitest run src/hooks/useConversationHistory/conversationTokenUsage.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory/useConversationHistory.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
