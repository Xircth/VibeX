# FE-003 Snapshot Staleness Cleanup Plan

## Problem

`useConversationHistory.ts` contains the running-stream snapshot staleness
heuristic inline with React refs and stream subscription code. The heuristic is
pure, but currently it is only testable through the hook's async streaming
tests.

## Behavior To Preserve

- User messages, token usage entries, and loading entries are ignored when
  comparing snapshots.
- Non-ignored normalized entries are compared in order.
- A running process snapshot is stale only when another displayed process has
  the same non-ignored snapshot sequence.
- The process being streamed must not mark itself stale.

## Cleanup Pass

1. Extract snapshot comparison key derivation and stale-running-snapshot
   detection into `conversationSnapshotStaleness.ts`.
2. Keep `useConversationHistory.ts` as the owner of refs and pass the current
   displayed process map into the helper.
3. Add direct unit tests for ignored entry types, self-suppression, duplicate
   detection, and different-order/non-matching snapshots.

## Verification

- `pnpm vitest run src/hooks/useConversationHistory/conversationSnapshotStaleness.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory/useConversationHistory.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
