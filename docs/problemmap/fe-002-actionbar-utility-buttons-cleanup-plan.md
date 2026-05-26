# FE-002 ActionBar Utility Buttons Cleanup Plan

Scope: `frontend/src/components/tasks/follow-up/ActionBar.tsx` and a new utility-buttons component under `frontend/src/components/tasks/follow-up/`.

## Smell

`ActionBar` still renders compact-context and prompt-enhancement utility buttons inline. That mixes stable utility-button presentation, loading icons, availability gates, and user-visible labels with queue/send/stop controls. The compact button label is also mojibake in the current file, so its title and aria-label are not trustworthy.

## Behavior Locks

- Compact button renders with the correct `压缩上下文` title and aria-label.
- Compact button is disabled when compacting is unavailable and calls `onCompactContext` when available.
- Compact loading state swaps the archive icon for a spinner.
- Prompt-enhancement button renders only when enabled.
- Prompt-enhancement button respects availability/loading gates and calls `onEnhancePrompt` when available.

## Cleanup Pass

1. Add `ActionBarUtilityButtons.test.tsx` before implementation.
2. Extract `ActionBarUtilityButtons` with compact and prompt-enhancement buttons.
3. Replace the inline compact/enhance button JSX in `ActionBar`.
4. Remove now-unused icon imports from `ActionBar`.

## Non-Goals

- Do not change queue/cancel/stop/send behavior.
- Do not change executor profile controls or image attachment behavior.
- Do not change compact/enhance business logic, only presentation wiring.

## Verification

- Red/green targeted Vitest for `ActionBarUtilityButtons`.
- Existing `ActionBar.test.tsx`.
- Follow-up directory regression tests.
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
