# FE-002 Topbar Component Cleanup Plan

## Scope

- Extract the composer topbar JSX from `TaskFollowUpSection.tsx` into a focused presentation component.
- Keep state derivation, hooks, mutations, and callback ownership in `TaskFollowUpSection.tsx`.
- Preserve existing child components and labels without introducing dependencies.

## Behavior Lock

- Add a component test for the extracted topbar before implementation.
- Cover changed-file summary visibility, jump-to-previous button behavior, todo rendering, and session selector gating.

## Cleanup Steps

1. Add a failing `SessionComposerTopbar` test that imports the not-yet-existing component.
2. Move the topbar JSX into `frontend/src/components/tasks/follow-up/SessionComposerTopbar.tsx`.
3. Replace the inline topbar in `TaskFollowUpSection.tsx` with the new component.
4. Run the targeted component test, follow-up test directory, frontend checks, full checks, and whitespace check.

## Non-Goals

- Do not change session selection behavior.
- Do not change topbar styling or visible copy.
- Do not move composer input or action bar in this pass.
