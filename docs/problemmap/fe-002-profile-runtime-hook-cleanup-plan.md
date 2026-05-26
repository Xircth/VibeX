# FE-002 Profile Runtime Hook Cleanup Plan

Scope:
- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/sessionComposerDraft.ts`
- `frontend/src/components/tasks/follow-up/useSessionComposerExecutorProfileHydration.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerExecutorProfileHydration.test.tsx`

Smells:
- Boundary violation: executor-profile hydration and autosave side effects live in the component even though the decisions are already pure helper logic.
- Duplication pressure: component owns four coordination refs for one runtime concern.
- Missing runtime-level tests: pure helper tests exist, but no hook-level test proves effect ordering and ref updates.

Behavior lock:
- Add hook tests before implementation for scratch-id reset, default hydration, scratch profile application, latest-profile ref synchronization, and autosave de-duplication.

Pass order:
1. Add failing hook regression tests.
2. Extract profile hydration/autosave effects into a focused hook.
3. Replace inline refs/effects in `TaskFollowUpSection` with the hook.
4. Run targeted follow-up tests, frontend type/lint checks, and full repo gates.
