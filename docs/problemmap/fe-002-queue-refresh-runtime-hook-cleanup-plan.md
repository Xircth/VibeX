# FE-002 Queue Refresh Runtime Hook Cleanup Plan

Scope:
- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/useSessionComposerQueue.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerQueue.test.tsx`
- `frontend/src/components/tasks/follow-up/sessionComposerQueue.ts`

Smells:
- Boundary violation: queue status refresh triggers are split between `TaskFollowUpSection` and the queue hook.
- Duplication pressure: the component tracks previous process count only to decide when queue state should be refetched.
- Missing runtime-level tests: the pure refresh policy is covered, but hook tests do not prove session-id refreshes or process-count refreshes are wired.

Behavior lock:
- Add hook tests before implementation for session-id refresh, running process-count increases, stopped attempts, and missing-workspace suppression.

Pass order:
1. Add failing queue hook regression tests.
2. Move process-count/session-id refresh effects into `useSessionComposerQueue`.
3. Remove queue refresh refs/effects from `TaskFollowUpSection`.
4. Run targeted follow-up tests, frontend type/lint checks, and full repo gates.
