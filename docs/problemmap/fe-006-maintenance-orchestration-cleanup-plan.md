# FE-006 Maintenance Orchestration Cleanup Plan

## Scope

- `frontend/src/App.tsx`
- new pure maintenance orchestration helper and focused tests

## Behavior Lock

- Add regression tests before implementation for the maintenance effect decisions:
  - maintenance does not start without config, after it already started, before disclaimer acknowledgement, or when both maintenance features are disabled
  - app update toast only follows the existing `auto_update_enabled !== false && update_available` policy
  - local dependency prompt keeps the existing visible-tool filter plus `localToolNeedsUpdatePrompt` policy

## Smells

- Boundary violation: `App.tsx` decides maintenance start policy and interprets maintenance status inline.
- Duplication risk: local dependency prompt filtering is split between the effect and the already extracted prompt-policy helper.
- Weak testability: the current effect can only be tested by mounting the app shell and mocking toast/API behavior.

## Pass Order

1. Add pure helper tests for maintenance start, app update prompt, and local dependency prompt decisions.
2. Extract decision helpers without moving toast rendering or install side effects.
3. Update `App.tsx` to call the helper and keep only orchestration/subscription work in the effect.
4. Run targeted tests, frontend checks, full checks, lint, and whitespace validation.

## Non-Goals

- Do not change toast text, toast duration, or install API arguments.
- Do not alter the one-shot `maintenanceStartedRef` behavior.
- Do not split the route table in this pass.
