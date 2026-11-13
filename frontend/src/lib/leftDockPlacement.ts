import type { DockviewApi } from 'dockview-react';
import {
  ACTIVITY_RAIL_ITEMS,
  ACTIVITY_RAIL_PANEL_TITLES,
  type ActivityRailItemId,
} from '@/lib/activityRailOrder';
import {
  boxContains,
  classifyLeftDockSplit,
  ghostBoxForZone,
  innerSizeAfterOuterResize,
  ratioFromSizes,
  resolveLeftPanelDropZone,
  sizesFromRatio,
  unionBoxes,
  type Box,
  type LeftPanelDropZone,
  type Point,
} from '@/lib/leftPanelSplit';
import {
  readLeftPanelSplitMemory,
  writeLeftPanelSplitMemory,
} from '@/lib/leftPanelSplitMemory';
import { listLeftDockGroups } from '@/utils/dockviewGroupPolicy';
import { syncDockviewGroupRegistry } from '@/utils/dockviewHelpers';
import { settleDockviewGroupWidths } from '@/utils/dockviewStartupSizing';
import { MIN_LEFT_PANEL_WIDTH } from '@/utils/dockviewWorkspaceConstraints';

const MIN_PANE = 80;
const MIN_DOCK_GROUP_WIDTH = 120;
const MAX_DOCK_WIDTH_RATIO = 0.34;
const RIGHT_EDGE_DROP_WIDTH = 180;
const LEFT_EDGE_DROP_WIDTH = 180;

export interface ShellNavDropTarget {
  side: 'left' | 'right';
  zone: LeftPanelDropZone;
  targetPanelId?: ActivityRailItemId;
  containerBox: Box;
  ghostBox: Box;
}

export interface ShellNavPanelMeasurement {
  panelId: ActivityRailItemId;
  side: 'left' | 'right';
  box: Box;
}

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

function isRightSideShellNavGroup(group: { element?: HTMLElement }): boolean {
  return group.element?.getAttribute('data-shell-nav-side') === 'right';
}

export function measureLeftDockBox(api: DockviewApi): Box | null {
  const boxes = listLeftDockGroups(api.groups)
    .filter((group) => group.api.isVisible && !isRightSideShellNavGroup(group))
    .map((group) => boxFromElement(group.element))
    .filter((box): box is Box => box !== null);
  return unionBoxes(boxes);
}

export function measureShellNavPanels(
  api: DockviewApi
): ShellNavPanelMeasurement[] {
  const result: ShellNavPanelMeasurement[] = [];
  for (const group of listLeftDockGroups(api.groups)) {
    if (!group.api.isVisible) continue;
    const rawPanelId = group.activePanel?.id ?? group.panels[0]?.id;
    if (
      !rawPanelId ||
      !ACTIVITY_RAIL_ITEMS.includes(rawPanelId as ActivityRailItemId)
    ) {
      continue;
    }
    const box =
      boxFromElement(group.element) ??
      (group.api.width > 0 && group.api.height > 0
        ? {
            x: 0,
            y: 0,
            width: group.api.width,
            height: group.api.height,
          }
        : null);
    if (!box) continue;
    result.push({
      panelId: rawPanelId as ActivityRailItemId,
      side: isRightSideShellNavGroup(group) ? 'right' : 'left',
      box,
    });
  }
  return result;
}

export function swapLeftDockPanels(
  api: DockviewApi,
  panelAId: ActivityRailItemId,
  panelBId: ActivityRailItemId
): boolean {
  if (panelAId === panelBId) return false;
  const panelA = api.getPanel(panelAId);
  const panelB = api.getPanel(panelBId);
  if (!panelA || !panelB) return false;

  const groupA = panelA.group;
  const groupB = panelB.group;
  if (!groupA || !groupB || groupA === groupB) return false;

  const boxA = boxFromElement(groupA.element);
  const boxB = boxFromElement(groupB.element);
  const widthA = Math.max(
    MIN_LEFT_PANEL_WIDTH,
    Math.round(groupA.api.width || boxA?.width || MIN_LEFT_PANEL_WIDTH)
  );
  const widthB = Math.max(
    MIN_LEFT_PANEL_WIDTH,
    Math.round(groupB.api.width || boxB?.width || MIN_LEFT_PANEL_WIDTH)
  );
  const heightA = Math.round(groupA.api.height || boxA?.height || 0);
  const heightB = Math.round(groupB.api.height || boxB?.height || 0);

  const otherGroupSnapshots = listLeftDockGroups(api.groups)
    .filter(
      (group) => group.api.isVisible && group !== groupA && group !== groupB
    )
    .map((group) => ({
      group,
      width: Math.max(
        MIN_LEFT_PANEL_WIDTH,
        Math.round(
          group.api.width ||
            boxFromElement(group.element)?.width ||
            MIN_LEFT_PANEL_WIDTH
        )
      ),
    }));

  syncDockviewGroupRegistry(api);
  const component = (
    api as unknown as {
      component?: {
        moveGroupOrPanel?: (options: {
          from: { groupId: string; panelId?: string };
          to: { group: unknown; position: string; index?: number };
          keepEmptyGroups?: boolean;
          skipSetActive?: boolean;
        }) => void;
      };
    }
  ).component;

  if (typeof component?.moveGroupOrPanel === 'function') {
    component.moveGroupOrPanel({
      from: { groupId: groupA.id, panelId: panelAId },
      to: { group: groupB, position: 'center' },
      keepEmptyGroups: true,
    });
    component.moveGroupOrPanel({
      from: { groupId: groupB.id, panelId: panelBId },
      to: { group: groupA, position: 'center' },
      keepEmptyGroups: true,
    });
  } else {
    const stackedVertically =
      boxA &&
      boxB &&
      Math.abs(boxA.x - boxB.x) <= 4 &&
      Math.abs(boxA.y - boxB.y) > 4;
    const direction = stackedVertically
      ? boxA.y < boxB.y
        ? 'below'
        : 'above'
      : !boxA || !boxB || boxA.x <= boxB.x
        ? 'right'
        : 'left';
    const sideB = isRightSideShellNavGroup(groupB) ? 'right' : 'left';
    api.removePanel(panelA);
    if (groupA.panels.length === 0 && api.groups.includes(groupA)) {
      try {
        api.removeGroup(groupA);
      } catch {
        // Ignore removal errors in test doubles.
      }
    }
    const recreated = api.addPanel({
      id: panelAId,
      component: panelAId,
      title: ACTIVITY_RAIL_PANEL_TITLES[panelAId] ?? panelAId,
      position: {
        referencePanel: panelB,
        direction,
      },
    });
    recreated.group.element?.setAttribute('data-left-dock', 'true');
    recreated.group.element?.setAttribute('data-shell-nav-side', sideB);
    settleDockviewGroupWidths([
      ...otherGroupSnapshots,
      { group: groupB, width: widthB },
      { group: recreated.group, width: widthA },
    ]);
    return true;
  }

  const stackedVertically =
    boxA &&
    boxB &&
    Math.abs(boxA.x - boxB.x) <= 4 &&
    Math.abs(boxA.y - boxB.y) > 4;

  if (stackedVertically) {
    if (heightA > 0 && heightB > 0 && Math.abs(heightA - heightB) > 2) {
      groupA.api.setSize({ height: heightB });
      groupB.api.setSize({ height: heightA });
    }
    settleDockviewGroupWidths([
      ...otherGroupSnapshots,
      { group: groupA, width: widthA },
      { group: groupB, width: widthA },
    ]);
  } else {
    settleDockviewGroupWidths([
      ...otherGroupSnapshots,
      { group: groupA, width: widthB },
      { group: groupB, width: widthA },
    ]);
  }

  return true;
}

export function resolveShellNavDropTarget(
  api: DockviewApi,
  point: Point,
  sourcePanelId?: ActivityRailItemId
): ShellNavDropTarget | null {
  const shellGroups = listLeftDockGroups(api.groups).filter(
    (group) => group.api.isVisible
  );

  for (const group of shellGroups) {
    const box = boxFromElement(group.element);
    if (!box || !boxContains(box, point)) continue;
    const zone = resolveLeftPanelDropZone(point, box);
    if (!zone) continue;

    const side: 'left' | 'right' = isRightSideShellNavGroup(group)
      ? 'right'
      : 'left';
    const rawPanelId = group.activePanel?.id ?? group.panels[0]?.id;
    const targetPanelId = ACTIVITY_RAIL_ITEMS.includes(
      rawPanelId as ActivityRailItemId
    )
      ? (rawPanelId as ActivityRailItemId)
      : undefined;

    if (
      sourcePanelId &&
      targetPanelId === sourcePanelId &&
      shellGroups.length === 1
    ) {
      return null;
    }

    return {
      side,
      zone,
      targetPanelId,
      containerBox: box,
      ghostBox: ghostBoxForZone(box, zone),
    };
  }

  const stageEl =
    typeof document !== 'undefined'
      ? document.querySelector<HTMLElement>('.workspace-stage-host')
      : null;
  const stageBox = boxFromElement(stageEl);
  if (stageBox && boxContains(stageBox, point)) {
    const hasVisibleRightGroup = shellGroups.some((group) =>
      isRightSideShellNavGroup(group)
    );
    const rightStripWidth = Math.min(RIGHT_EDGE_DROP_WIDTH, stageBox.width / 3);
    if (
      !hasVisibleRightGroup &&
      point.x >= stageBox.x + stageBox.width - rightStripWidth
    ) {
      const ghostWidth = Math.min(240, Math.round(stageBox.width * 0.25));
      const ghostBox: Box = {
        x: stageBox.x + stageBox.width - ghostWidth,
        y: stageBox.y,
        width: ghostWidth,
        height: stageBox.height,
      };
      return {
        side: 'right',
        zone: 'right',
        containerBox: ghostBox,
        ghostBox,
      };
    }

    const hasVisibleLeftGroup = shellGroups.some(
      (group) => !isRightSideShellNavGroup(group)
    );
    const leftStripWidth = Math.min(LEFT_EDGE_DROP_WIDTH, stageBox.width / 3);
    if (!hasVisibleLeftGroup && point.x <= stageBox.x + leftStripWidth) {
      const ghostWidth = Math.min(240, Math.round(stageBox.width * 0.25));
      const ghostBox: Box = {
        x: stageBox.x,
        y: stageBox.y,
        width: ghostWidth,
        height: stageBox.height,
      };
      return {
        side: 'left',
        zone: 'left',
        containerBox: ghostBox,
        ghostBox,
      };
    }
  }

  return null;
}

export function applyLeftDockSplitSizes(
  api: DockviewApi,
  kind?: 'stack' | 'row'
): void {
  const groups = listLeftDockGroups(api.groups).filter(
    (group) => group.api.isVisible && !isRightSideShellNavGroup(group)
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

export function rebalanceLeftDockWidth(api: DockviewApi): void {
  const groups = listLeftDockGroups(api.groups).filter(
    (group) => group.api.isVisible && !isRightSideShellNavGroup(group)
  );
  if (groups.length === 0) return;

  const widths = groups.map((group) => ({
    group,
    width: Math.max(
      MIN_DOCK_GROUP_WIDTH,
      Math.round(group.api.width || boxFromElement(group.element)?.width || 0)
    ),
  }));
  const totalWidth = widths.reduce((total, item) => total + item.width, 0);
  const widthBudget = Math.max(
    groups.length * MIN_DOCK_GROUP_WIDTH,
    Math.round(api.width * MAX_DOCK_WIDTH_RATIO)
  );
  if (totalWidth <= widthBudget) return;

  settleDockviewGroupWidths(
    widths.map(({ group, width }) => {
      group.api.setConstraints({ minimumWidth: MIN_DOCK_GROUP_WIDTH });
      return { group, width: (width / totalWidth) * widthBudget };
    })
  );
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

  const ordered = items
    .slice()
    .sort((a, b) =>
      split === 'stack'
        ? a.box.y - b.box.y || a.box.x - b.box.x
        : a.box.x - b.box.x || a.box.y - b.box.y
    );
  const union = unionBoxes(ordered.map((item) => item.box));
  if (!union) return null;

  const total = split === 'stack' ? union.height : union.width;
  const first =
    split === 'stack' ? ordered[0].box.height : ordered[0].box.width;

  if (
    split === 'stack' &&
    previous &&
    previous.split === 'stack' &&
    Math.abs(previous.total - total) > 2
  ) {
    const nextFirst = innerSizeAfterOuterResize(
      previous.total,
      total,
      previous.first
    );
    ordered[0].group.api.setSize({ height: nextFirst });
    writeLeftPanelSplitMemory({
      stackRatio: ratioFromSizes(nextFirst, total),
    });
    return { split, total, first: nextFirst };
  }

  if (
    previous &&
    previous.split === split &&
    Math.abs(previous.first - first) > 2
  ) {
    writeLeftPanelSplitMemory(
      split === 'stack'
        ? { stackRatio: ratioFromSizes(first, total) }
        : { rowRatio: ratioFromSizes(first, total) }
    );
  }

  return { split, total, first };
}

export function isLeftDockSplit(api: DockviewApi): boolean {
  return (
    listLeftDockGroups(api.groups).filter((group) => group.api.isVisible)
      .length >= 2
  );
}

export function unsplitLeftDockKeepLeading(api: DockviewApi): boolean {
  const groups = listLeftDockGroups(api.groups).filter(
    (group) => group.api.isVisible
  );
  if (groups.length < 2) return false;

  const items = groups
    .map((group) => {
      const box = boxFromElement(group.element);
      return box ? { group, box } : null;
    })
    .filter((item): item is { group: (typeof groups)[number]; box: Box } =>
      Boolean(item)
    );
  if (items.length < 2) return false;

  const split = classifyLeftDockSplit(items.map((item) => item.box));
  const ordered = items
    .slice()
    .sort((a, b) =>
      split === 'row'
        ? a.box.x - b.box.x || a.box.y - b.box.y
        : a.box.y - b.box.y || a.box.x - b.box.x
    );

  for (const item of ordered.slice(1)) {
    for (const panel of [...item.group.panels]) {
      api.removePanel(panel);
    }
  }
  return true;
}
