# FE-002 Session Callback Runtime Hook Cleanup Plan

Scope:
- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/sessionComposerSession.ts`
- `frontend/src/components/tasks/follow-up/useSessionComposerSessionCallbacks.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerSessionCallbacks.test.tsx`

Smells:
- Boundary violation: session selection notifications and created-session profile memory are still component-owned runtime callbacks.
- Hidden coupling: default executor profile reads a ref mutated by a separate callback path.
- Missing runtime-level tests: pure derivations exist, but no hook test proves selection, parent notification suppression, profile memory storage, and parent created-session forwarding together.

Behavior lock:
- Add hook tests before implementation for selection callback ordering, missing-workspace notification suppression, created-session profile memory, executor-less profile suppression, and parent callback forwarding.

Pass order:
1. Add failing hook regression tests.
2. Extract session callback/ref ownership into `useSessionComposerSessionCallbacks`.
3. Replace inline callbacks/ref in `TaskFollowUpSection`.
4. Run targeted follow-up tests, frontend type/lint checks, and full repo gates.
