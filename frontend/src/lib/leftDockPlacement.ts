import type { DockviewApi } from 'dockview-react';
import {
  classifyLeftDockSplit,
  innerSizeAfterOuterResize,
  ratioFromSizes,
  sizesFromRatio,
  unionBoxes,
  type Box,
} from '@/lib/leftPanelSplit';
import {
  readLeftPanelSplitMemory,
  writeLeftPanelSplitMemory,
} from '@/lib/leftPanelSplitMemory';
import { listLeftDockGroups } from '@/utils/dockviewGroupPolicy';

const MIN_PANE = 80;

function boxFromElement(element: HTMLElement | undefined | null): Box | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function measureLeftDockBox(api: DockviewApi): Box | null {
  const boxes = listLeftDockGroups(api.groups)
    .filter((group) => group.api.isVisible)
    .map((group) => boxFromElement(group.element))
    .filter((box): box is Box => box !== null);
  return unionBoxes(boxes);
}

export function applyLeftDockSplitSizes(
  api: DockviewApi,
  kind?: 'stack' | 'row'
): void {
  const groups = listLeftDockGroups(api.groups).filter(
    (group) => group.api.isVisible
  );
  if (groups.length !== 2) return;

  const items = groups
    .map((group) => {
      const box = boxFromElement(group.element);
      return box ? { group, box } : null;
    })
    .filter((item): item is { group: (typeof groups)[number]; box: Box } =>
      Boolean(item)
    );
  if (items.length !== 2) return;

  const split = kind ?? classifyLeftDockSplit(items.map((item) => item.box));
  if (split === 'single') return;

  const ordered = items
    .slice()
    .sort((a, b) =>
      split === 'stack'
        ? a.box.y - b.box.y || a.box.x - b.box.x
        : a.box.x - b.box.x || a.box.y - b.box.y
    );
  const union = unionBoxes(ordered.map((item) => item.box));
  if (!union) return;

  const memory = readLeftPanelSplitMemory();
  if (split === 'stack') {
    const { first } = sizesFromRatio(union.height, memory.stackRatio, MIN_PANE);
    ordered[0].group.api.setSize({ height: first });
    return;
  }

  const { first } = sizesFromRatio(union.width, memory.rowRatio, MIN_PANE);
  ordered[0].group.api.setSize({ width: first });
}

export function syncLeftDockSplitFromLayout(
  api: DockviewApi,
  previous: { split: 'stack' | 'row'; total: number; first: number } | null
): { split: 'stack' | 'row'; total: number; first: number } | null {
  const groups = listLeftDockGroups(api.groups).filter(
    (group) => group.api.isVisible
  );
  if (groups.length !== 2) return null;

  const items = groups
    .map((group) => {
      const box = boxFromElement(group.element);
      return box ? { group, box } : null;
    })
    .filter((item): item is { group: (typeof groups)[number]; box: Box } =>
      Boolean(item)
    );
  if (items.length !== 2) return null;

  const split = classifyLeftDockSplit(items.map((item) => item.box));
  if (split === 'single') return null;

  const ordered = items.slice().sort((a, b) =>
    split === 'stack'
      ? a.box.y - b.box.y || a.box.x - b.box.x
      : a.box.x - b.box.x || a.box.y - b.box.y
  );
  const union = unionBoxes(ordered.map((item) => item.box));
  if (!union) return null;

  const total = split === 'stack' ? union.height : union.width;
  const first = split === 'stack' ? ordered[0].box.height : ordered[0].box.width;

  if (previous && previous.split === split && Math.abs(previous.total - total) > 2) {
    const nextFirst = innerSizeAfterOuterResize(
      previous.total,
      total,
      previous.first
    );
    if (split === 'stack') {
      ordered[0].group.api.setSize({ height: nextFirst });
    } else {
      ordered[0].group.api.setSize({ width: nextFirst });
    }
    writeLeftPanelSplitMemory(
      split === 'stack'
        ? { stackRatio: ratioFromSizes(nextFirst, total) }
        : { rowRatio: ratioFromSizes(nextFirst, total) }
    );
    return { split, total, first: nextFirst };
  }

  if (previous && previous.split === split && Math.abs(previous.first - first) > 2) {
    writeLeftPanelSplitMemory(
      split === 'stack'
        ? { stackRatio: ratioFromSizes(first, total) }
        : { rowRatio: ratioFromSizes(first, total) }
    );
  }

  return { split, total, first };
}
