# FE-002 Submit Cleanup Plan

## Scope

- Continue reducing `TaskFollowUpSection` by extracting pure follow-up
  submit, send, queue, and compact eligibility decisions.
- Keep React hooks, mutation calls, provider runtime sends, scratch writes, and
  UI rendering in their current owners for this pass.
- Preserve the current shortcut behavior: when an attempt is running, submit
  queues only if no queue is already present; otherwise submit sends directly.

## Behavior Locks

- Add pure unit coverage for:
  - queueable/sendable content detection
  - typing eligibility gates
  - send eligibility gates
  - compact eligibility gates
  - submit shortcut action selection
  - queued follow-up prompt construction

## Cleanup Pass

1. Add `frontend/src/components/tasks/follow-up/sessionComposerSubmit.ts`.
2. Move pure boolean/action decisions out of `TaskFollowUpSection.tsx`.
3. Keep the component responsible for calling the selected side effect.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerSubmit.test.ts`
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
