# FE-005 File Preview Labels Cleanup Plan

Scope: `frontend/src/components/file-tree/FilePreviewPopover.tsx` and the preview hints in `FileTreePanel.tsx`.

## Smell

The file preview popover contains visible mojibake in Chinese labels for the close action, loading state, image preview state, selection hints, clear selection, and add-to-chat action. This is historical baggage in user-facing UI copy, not a harmless terminal encoding artifact.

## Behavior Locks

- Text preview without a selection shows `未选择行`.
- Image preview shows `图片预览`.
- The close button exposes `关闭预览`.
- Loading state shows `正在加载文件...`.
- Text preview action buttons show `清除选择` and `添加到聊天`.
- Selection hints render the intended Chinese labels.

## Cleanup Pass

1. Add `FilePreviewPopover.test.tsx` before changing labels.
2. Replace mojibake strings with stable label constants.
3. Replace preview selection hint mojibake in `FileTreePanel`.
4. Keep preview behavior and layout unchanged.

## Non-Goals

- Do not change preview selection interaction.
- Do not change image preview rendering.
- Do not change drag/drop behavior.

## Verification

- Red/green targeted Vitest for `FilePreviewPopover`.
- Existing file-tree utility and truncated root-scan tests.
- `pnpm run check`
- `pnpm run lint`
- `git diff --check`
