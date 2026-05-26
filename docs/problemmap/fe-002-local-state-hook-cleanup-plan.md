# FE-002 Local State Hook Cleanup Plan

## Scope

- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/useSessionComposerLocalState.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerLocalState.test.tsx`
- ProblemMap ledger entries for FE-002.

## Smell

`TaskFollowUpSection` still owns the composer local state cluster directly: draft text, attached image objects, derived image paths, selected executor profile, effective profile fallback, and the mutable executor profile ref shared by persistence hooks. These pieces form the state boundary consumed by the extracted runtime hooks.

Current code has a required ordering split: image paths and the executor profile ref must exist before scratch/default-profile derivation, while selected profile state must initialize after the default profile is derived. The cleanup therefore keeps both state groups in one module but exposes two hook entry points to preserve initialization behavior.

## Behavior Lock

Add hook-level tests for:

- default empty draft and image state;
- derived image paths following attachment state;
- selected executor profile fallback to the current default;
- explicit selected profile overriding later default changes;
- executor profile ref availability for downstream hooks.

## Cleanup Steps

1. Add small local-state/profile-selection hooks that own the state cluster without changing update semantics.
2. Replace the direct `useState` / `useRef` calls in `TaskFollowUpSection`.
3. Keep existing runtime hooks and setter contracts unchanged.
4. Run the new hook test, relevant draft/image/profile tests, the full follow-up suite, frontend/repo check and lint, and `git diff --check`.

## Non-Goals

- Do not change draft persistence, image upload/removal, or executor profile hydration behavior.
- Do not merge runtime side effects into this local-state hook.
- Do not change JSX structure or UI copy.
