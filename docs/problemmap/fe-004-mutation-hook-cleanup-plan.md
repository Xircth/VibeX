# FE-004 Mutation Hook Cleanup Plan

## Scope

- `frontend/src/components/kanban/KanbanSessionHub.tsx`
- `frontend/src/components/kanban/session-hub/useKanbanSessionMutations.ts`
- `frontend/src/components/kanban/session-hub/UseKanbanSessionMutations.test.tsx`
- `docs/problemmap/frontend.md`
- `docs/problemmap/README.md`

## Smell

`KanbanSessionHub.tsx` still owns mutation orchestration directly:

- create-session API payload execution
- draft scratch profile persistence
- create-success query invalidation
- created-session placement and pending-id handling
- create popover reset
- rename API execution and query invalidation

The previous FE-004 passes moved pure derivation into helpers, but the component still carries mutation lifecycle details. That keeps the Hub responsible for both rendering state and cross-cache side effects.

## Behavior Lock

Add a focused hook test before extraction:

- create mutation calls `sessionsApi.createProject` with the tested request payload
- create mutation writes draft scratch data when an executor profile exists
- create success invalidates project/worktree/repo/session query keys
- create success places and tracks the created session, clears the create name, and closes the popover
- rename mutation calls `sessionsApi.rename` and invalidates workspace/session query keys

## Cleanup Pass

1. Introduce `useKanbanSessionMutations` under `session-hub/`.
2. Move create and rename `useMutation` blocks out of `KanbanSessionHub.tsx`.
3. Keep state ownership in `KanbanSessionHub.tsx`; pass narrow side-effect callbacks into the hook.
4. Preserve existing helper-based create request construction from `session-hub/utils.ts`.

## Verification

- `pnpm vitest run src/components/kanban/session-hub/UseKanbanSessionMutations.test.tsx`
- `pnpm vitest run src/components/kanban`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
