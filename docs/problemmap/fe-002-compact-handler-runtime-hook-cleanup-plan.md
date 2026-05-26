# FE-002 Compact Handler Runtime Hook Cleanup Plan

## Scope

- `frontend/src/components/tasks/TaskFollowUpSection.tsx`
- `frontend/src/components/tasks/follow-up/useSessionComposerContextCompact.ts`
- `frontend/src/components/tasks/follow-up/UseSessionComposerContextCompact.test.tsx`
- ProblemMap ledger entries for FE-002.

## Smell

`TaskFollowUpSection` still creates a `handleCompactContext` wrapper whose only job is to pass `canCompactContext` into the compact hook action. The actual compact runtime side effects already live in `useSessionComposerContextCompact`, so eligibility should close over hook state instead of leaking a callback wrapper back into the component.

## Behavior Lock

Add a hook-level regression test that calls `handleCompactContext()` without arguments and verifies the hook uses its current `canCompactContext` input to suppress or send the compact turn.

## Cleanup Steps

1. Extend the compact hook inputs with `canCompactContext`.
2. Change `handleCompactContext` to take no runtime eligibility argument and use the hook input internally.
3. Remove the component-level wrapper callback and pass the hook action directly to `SessionComposerInput`.
4. Run targeted hook/helper tests, the full follow-up suite, frontend/repo check and lint, and `git diff --check`.

## Non-Goals

- Do not change compact eligibility policy.
- Do not change provider runtime compact payloads or pending-process timeout behavior.
- Do not broaden this pass into unrelated focus/blur or editor orchestration.
