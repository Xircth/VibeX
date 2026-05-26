# FE-002 Profile Source Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and
`frontend/src/components/tasks/follow-up/sessionComposerDraft.ts`.

## Smells

- Boundary violation: the default executor profile priority chain is embedded in
  the component, mixing scratch data, process history, created-session memory,
  session fallback, config fallback, and available-profile fallback.
- Missing tests: the priority order is user-visible but only protected by
  incidental component behavior.
- Duplication risk: profile-source selection and profile hydration are adjacent
  state-machine concerns but only the hydration decisions are pure/tested.

## Behavior Lock

- Add focused tests for default executor profile source priority:
  scratch profile, latest process profile, created-session memory, session
  executor, config executor profile, first available profile, then `null`.

## Pass Order

1. Add failing regression tests for the default profile source priority.
2. Extract a pure helper for default executor profile selection.
3. Replace the component's inline `useMemo` branch chain with that helper.
4. Re-run the FE-002 helper tests plus full frontend/project checks.
