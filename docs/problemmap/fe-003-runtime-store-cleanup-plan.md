# FE-003 Runtime Store Cleanup Plan

## Problem

`useConversationHistory.ts` owns React effects, stream subscription orchestration,
entry flattening, token usage emission, and a module-level runtime cache in one
file. The cache is shared across hook instances but is only implicit inside the
hook module, so multi-instance behavior, cache eviction, and stream id generation
are hard to audit independently.

## Behavior To Preserve

- Same-session remounts can restore displayed process entries before the prior
  hook instance unmounts.
- Running process streams reconnect with the cached displayed entries as their
  baseline.
- A loading execution-process refresh must not emit an empty historic update
  that clears cached assistant output.
- Stream ids remain unique per subscription attempt.

## First Cleanup Pass

1. Extract the module-level conversation runtime cache and stream id generator
   into `conversationRuntimeStore.ts`.
2. Keep `useConversationHistory.ts` as the owner of React refs and effects.
3. Re-export `clearConversationRuntimeForTests` from the hook module so existing
   tests and call sites keep their import contract.
4. Add direct runtime-store tests for:
   - cloned cache writes do not retain later caller mutations;
   - non-cloned cache writes preserve the live state reference;
   - oldest cache entries are evicted after the configured limit;
   - stream ids are unique and include the execution process id.

## Out Of Scope For This Pass

- Rewriting `flattenEntriesForEmit`.
- Changing stream retry timing or retry counts.
- Changing late historic reload behavior.
- Changing module-cache retention semantics beyond moving them behind named
  store functions.

## Verification

- `pnpm vitest run src/hooks/useConversationHistory/conversationRuntimeStore.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory/useConversationHistory.test.ts`
- `pnpm vitest run src/hooks/useConversationHistory`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
