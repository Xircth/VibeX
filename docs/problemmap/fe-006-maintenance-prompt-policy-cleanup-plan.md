# FE-006 Maintenance Prompt Policy Cleanup Plan

## Scope

- Extract local dependency update prompt policy from `App.tsx` into a pure helper module.
- Preserve existing version comparison semantics: optional `v` prefix, dot/dash splitting, missing numeric parts as zero, and installed tools without complete version bounds do not prompt.
- Leave toast rendering and install execution in `App.tsx`.

## Behavior Lock

- Add unit tests for version ordering and local-tool prompt decisions before editing `App.tsx`.

## Cleanup Steps

1. Add a failing test that imports the not-yet-existing maintenance prompt helper.
2. Move `compareVersionLike` and `localToolNeedsUpdatePrompt` into the helper module.
3. Import the helper from `App.tsx` and delete the local copies.
4. Run targeted tests, frontend checks, full checks, lint, and whitespace check.

## Non-Goals

- Do not change update toast UI.
- Do not change install-system-dependencies execution.
- Do not change backend maintenance status contracts.
