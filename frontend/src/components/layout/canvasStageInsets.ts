import type { DockviewApi } from 'dockview-react';
import { slotOfZone, type LayoutArrangement } from '@/lib/layoutArrangement';
import {
  compareEditorGroups,
  getGroupElement,
  isEditorGroup,
  isLeftGroup,
  isRightShellNavGroup,
} from '@/utils/dockviewGroupPolicy';

export interface CanvasStageInsets {
  left: number;
  right: number;
}

export function measureCanvasStageInsets(
  api: Pick<DockviewApi, 'groups'> | null | undefined,
  host: HTMLElement | null | undefined,
  arrangement: LayoutArrangement
): CanvasStageInsets {
  if (!api || !host) {
    return { left: 0, right: 0 };
  }

  const hostRect = host.getBoundingClientRect();
  const editorGroups = api.groups
    .filter((group) => isEditorGroup(group) && group.api.isVisible)
    .sort(compareEditorGroups);

  let editorCenterX: number | null = null;
  for (const editorGroup of editorGroups) {
    const editorRect = getGroupElement(editorGroup)?.getBoundingClientRect();
    if (editorRect && editorRect.width > 0) {
      editorCenterX = editorRect.left + editorRect.width / 2;
      break;
    }
  }

  let left = 0;
  let right = 0;
  for (const group of api.groups) {
    // Only Zone A shell navigation dock groups sit outside the Infinite Canvas stage;
    // editor, session, and bottom groups all belong to Zone B and are covered by the canvas.
    if (!isLeftGroup(group) && !isRightShellNavGroup(group)) continue;
    if (!group.api.isVisible || group.panels.length === 0) continue;

    let side: 'left' | 'right' = 'left';
    if (isRightShellNavGroup(group)) {
      side = 'right';
    } else {
      side = slotOfZone(arrangement, 'dock') === 'right' ? 'right' : 'left';
    }

    const el = getGroupElement(group);
    const viewEl = el?.parentElement ?? el;
    const rect = viewEl?.getBoundingClientRect();
    if (rect && rect.width > 0 && hostRect.width > 0) {
      if (editorCenterX !== null) {
        side = rect.left + rect.width / 2 > editorCenterX ? 'right' : 'left';
      }
      if (side === 'right') {
        right = Math.max(
          right,
          Math.max(0, Math.round(hostRect.right - rect.left))
        );
      } else {
        left = Math.max(
          left,
          Math.max(0, Math.round(rect.right - hostRect.left))
        );
      }
    } else {
      const fallbackWidth =
        typeof group.api?.width === 'number' && group.api.width > 0
          ? group.api.width
          : typeof group.width === 'number' && group.width > 0
            ? group.width
            : 0;
      if (fallbackWidth > 0) {
        if (side === 'right') {
          right += Math.round(fallbackWidth);
        } else {
          left += Math.round(fallbackWidth);
        }
      }
    }
  }

  if (hostRect.width > 0 && left + right > hostRect.width) {
    if (left > 0 && right === 0) {
      left = Math.round(hostRect.width);
    } else if (right > 0 && left === 0) {
      right = Math.round(hostRect.width);
    }
  }

  return { left, right };
}

export function findCanvasBoundarySash(
  host: HTMLElement | null | undefined,
  insets: CanvasStageInsets,
  side: 'left' | 'right'
): HTMLElement | null {
  if (!host) return null;
  const hostRect = host.getBoundingClientRect();
  const boundaryX =
    side === 'left'
      ? hostRect.left + insets.left
      : hostRect.right - insets.right;
  const sashes = Array.from(
    host.querySelectorAll<HTMLElement>(
      '.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash, .dv-sash'
    )
  );
  let bestSash: HTMLElement | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const sash of sashes) {
    const rect = sash.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const centerX = rect.left + rect.width / 2;
    const dist = Math.abs(centerX - boundaryX);
    if (dist < bestDist && dist <= 16) {
      bestDist = dist;
      bestSash = sash;
    }
  }
  return bestSash;
}
