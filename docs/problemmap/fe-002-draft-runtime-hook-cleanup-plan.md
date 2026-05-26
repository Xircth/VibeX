# FE-002 Draft Runtime Hook Cleanup Plan

Scope:
- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/sessionComposerDraft.ts`
- `frontend/src/components/tasks/follow-up/sessionComposerSubmit.ts`
- `frontend/src/components/tasks/follow-up/useSessionComposerDraftHydration.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerDraftHydration.test.tsx`

Smells:
- Boundary violation: draft scratch hydration and after-send local cleanup still share a ref owned by the component.
- Duplication pressure: after-send cleanup calls the same pure cleanup helper twice in the component to split message and image state.
- Missing runtime-level tests: pure helpers are covered, but no hook test proves hydration suppression, preview revocation, cleanup, and scratch deletion wiring.

Behavior lock:
- Add hook tests before implementation for loading suppression, once-per-scratch hydration, stored image path hydration, preview revocation, cleanup hydration-id advancement, and scratch deletion gating.

Pass order:
1. Add failing hook regression tests.
2. Extract draft hydration plus after-send cleanup into a focused hook.
3. Replace inline component ref/effect/cleanup body with the hook result.
4. Run targeted follow-up tests, frontend type/lint checks, and full repo gates.
