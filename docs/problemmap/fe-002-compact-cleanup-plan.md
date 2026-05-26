# FE-002 Context Compact Cleanup Plan

## Scope

- Continue reducing `TaskFollowUpSection` by extracting pure context compact
  turn/pending-process/error policy.
- Keep `sendProviderRuntimeTurn`, React state updates, timers, and UI side
  effects in `TaskFollowUpSection` for this pass.
- Preserve current semantics:
  - compact is skipped unless session, workspace, executor profile, and compact
    eligibility are all present
  - compact sends exactly `/compact`
  - pending compact state clears when the matching process appears
  - only running context compact processes block the composer
  - failed compact starts show the existing user-facing prefix

## Behavior Locks

- Add pure unit coverage for:
  - compact turn input construction and skip gates
  - provider runtime execution process id extraction
  - pending compact process clearing
  - running context compact process detection
  - compact error message fallback

## Cleanup Pass

1. Add `frontend/src/components/tasks/follow-up/sessionComposerCompact.ts`.
2. Move pure context compact helpers out of `TaskFollowUpSection.tsx`.
3. Keep `TaskFollowUpSection.tsx` responsible only for side effects.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerCompact.test.ts`
- FE-002 combined helper tests
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
