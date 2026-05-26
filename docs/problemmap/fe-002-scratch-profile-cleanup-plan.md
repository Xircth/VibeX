# FE-002 Scratch/Profile Hydration Cleanup Plan

## Scope

- Continue reducing `TaskFollowUpSection` by extracting pure executor-profile
  hydration decisions around draft scratch changes.
- Keep React refs/effects, `useScratch`, and selected-profile state setters in
  `TaskFollowUpSection` for this pass.
- Preserve current semantics:
  - scratch id changes or missing selected profile reset selection to the
    default profile
  - when switching scratch ids, a selected variant is preserved if the new
    default has the same executor but no variant
  - scratch-load hydration applies the default profile once per scratch id
  - scratch executor profile application is keyed by scratch id + profile key
    and skips when the current profile already has the same key

## Behavior Locks

- Add pure unit coverage for:
  - selected-profile reset/preserve decision on scratch id changes
  - default-profile hydration once per scratch id
  - scratch executor profile application keying and current-profile skip

## Cleanup Pass

1. Extend `sessionComposerDraft.ts` with profile hydration decisions.
2. Replace inline executor profile hydration branches in
   `TaskFollowUpSection.tsx`.
3. Keep side effects local to the component.

## Verification

- `pnpm vitest run src/components/tasks/follow-up/sessionComposerDraft.test.ts`
- FE-002 combined helper tests
- `pnpm run frontend:check`
- `pnpm run frontend:lint`
- `pnpm run check`
- `pnpm run lint`
