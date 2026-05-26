# FE-006 Startup Prompt Gate Cleanup Plan

## Scope

- Extract the startup prompt ordering from `App.tsx` into a pure helper.
- Preserve the current sequence: settings routes skip prompts, disclaimer first, onboarding second, release notes silent dismissal last.
- Leave dialog rendering, navigation, config persistence, and maintenance effects in `App.tsx`.

## Behavior Lock

- Add unit tests for settings-route suppression, disclaimer priority, onboarding priority after disclaimer, release-note dismissal after onboarding, and no-op when all gates are clear.

## Cleanup Steps

1. Add a failing test that imports the not-yet-existing startup gate helper.
2. Implement the helper in a small module.
3. Replace the inline `App.tsx` gate condition chain with the helper.
4. Run the targeted test, frontend checks, full checks, lint, and whitespace check.

## Non-Goals

- Do not change onboarding or disclaimer UI.
- Do not change maintenance/update toast behavior.
- Do not change route definitions in this pass.
