# FE-002 Session Derivation Cleanup Plan

Scope: `frontend/src/components/tasks/TaskFollowUpSection.tsx` and a new
`frontend/src/components/tasks/follow-up/sessionComposerSession.ts` helper.

## Smells

- Boundary violation: `TaskFollowUpSection` owns workspace id source precedence,
  active session id derivation, selected session summary lookup, and selector
  labels even though these are pure view-model decisions.
- Missing tests: workspace id precedence, new-session session id suppression, and
  compact session label truncation are user-visible but not directly locked.
- Complex implementation: session selector display state is mixed into the same
  component body as runtime send, queue, scratch, image, and compact side effects.

## Behavior Lock

- Add focused tests for workspace id priority:
  active worktree, route param, prop, session workspace, then `null`.
- Add focused tests for active session id:
  new-session mode yields `undefined`, otherwise the current session id.
- Add focused tests for selector labels:
  new-session labels use the next sequence number, existing selections include
  display name and continuity label, missing selection falls back to the default
  conversation label, and compact labels truncate by ASCII/CJK display units.

## Pass Order

1. Add failing regression tests for session derivation.
2. Extract pure helpers into `sessionComposerSession.ts`.
3. Replace the component's inline workspace/session/label derivation.
4. Re-run FE-002 helper tests and full project verification.
