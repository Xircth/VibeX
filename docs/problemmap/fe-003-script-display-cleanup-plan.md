# FE-003 Script Display Cleanup Plan

## Problem

`useConversationHistory.ts` builds setup/cleanup/archive/tool-install script
display entries inside the large flattening callback. That branch mixes script
context naming, live process status checks, exit-status formatting, output
joining, and patch-key construction with unrelated coding-agent conversation
flattening.

## Behavior To Preserve

- `SetupScript`, `CleanupScript`, `ArchiveScript`, and `ToolInstallScript`
  contexts emit tool-use entries with the existing labels.
- `DevServer` script requests are not rendered in conversation history.
- Running scripts emit a `created` tool status and `null` exit status.
- Completed scripts use the numeric exit code to choose `success` or `failed`.
- Missing live process data keeps the existing successful exit-code-zero
  fallback.
- Script output is built by joining stored entry content with newlines.

## Cleanup Pass

1. Extract script display entry construction into
   `conversationScriptDisplay.ts`.
2. Return both the generated display entry and process-state flags needed by the
   flattening callback.
3. Keep next-action decisions and hook live-process lookup in
   `useConversationHistory.ts`.

## Verification

- `pnpm vitest run src/hooks/useConversationHistory/conversationScriptDisplay.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory/useConversationHistory.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
