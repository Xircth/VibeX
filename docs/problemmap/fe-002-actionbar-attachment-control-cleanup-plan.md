# FE-002 ActionBar Attachment Control Cleanup Plan

Scope: `frontend/src/components/tasks/follow-up/ActionBar.tsx` and a new focused attachment-control component under `frontend/src/components/tasks/follow-up/`.

## Smell

`ActionBar` still owns the hidden file input ref, image-only filtering, input reset, and paperclip button rendering inline. This is a small but concrete prop/JSX boundary leak in the remaining FE-002 action-bar surface: button layout and file-input behavior are mixed with queue/send/stop/compact controls.

## Behavior Locks

- The attachment control keeps the paperclip button label and disabled behavior.
- Clicking the paperclip button opens the hidden file input.
- File input changes pass only image files to `onAttachImages`.
- The input value is reset after every change, including changes with no image files.

## Cleanup Pass

1. Add `ActionBarImageButton.test.tsx` before implementation.
2. Extract `ActionBarImageButton` with the hidden file input, paperclip button, and image-file filtering.
3. Replace the inline attachment input/button in `ActionBar`.
4. Remove now-unused imports and local handlers from `ActionBar`.

## Non-Goals

- Do not change queue/send/stop/compact logic.
- Do not change executor profile controls.
- Do not change accepted file types beyond the existing `image/*` behavior.

## Verification

- Red/green targeted Vitest for `ActionBarImageButton`.
- Existing `ActionBar.test.tsx`.
- FE-002 follow-up tests if the local surface changes more broadly.
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
