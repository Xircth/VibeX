# FE-002 Queue Runtime Hook Cleanup Plan

## Scope

- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/useSessionComposerQueue.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerQueue.test.tsx`
- `frontend/src/components/tasks/follow-up/sessionComposerQueue.ts`
- `docs/problemmap/frontend.md`
- `docs/problemmap/README.md`

## Smell

`TaskFollowUpSection.tsx` still owns queue runtime side effects directly:

- queue status `useQuery`
- queue/cancel `useMutation`
- queue API request shaping
- optimistic query-cache replacement after queue/cancel
- public `queueMessage` and `cancelQueue` callbacks
- derived queue snapshot and indicator state

The pure queue policies already live in `sessionComposerQueue.ts`, but the component still wires the runtime boundary inline. That keeps data fetching and mutation lifecycle details mixed with composer rendering and higher-level send/upload flows.

## Behavior Lock

Add a hook-level regression test before extraction:

- the hook reads queue status through `queueApi.getStatus`
- `queueMessage` calls `queueApi.queue` with executor/profile/image payload
- queue success writes the returned status to `['queue-status', sessionId]`
- `cancelQueue` calls `queueApi.cancel`
- cancel success writes the returned status to `['queue-status', sessionId]`
- missing session ids suppress queue and cancel mutations

## Cleanup Pass

1. Add `useSessionComposerQueue` under `follow-up/`.
2. Move queue query/mutations and queue/cancel callbacks out of `TaskFollowUpSection.tsx`.
3. Keep editor-change and image-upload callers using the returned `cancelMutation` for this pass.
4. Preserve the existing pure helpers from `sessionComposerQueue.ts`.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/UseSessionComposerQueue.test.tsx`
- `pnpm vitest run src/components/tasks/follow-up/sessionComposerQueue.test.ts`
- `pnpm vitest run src/components/tasks/follow-up`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
