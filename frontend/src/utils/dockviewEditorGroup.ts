import type { DockviewApi } from 'dockview-react';
import { slotOfZone, type LayoutArrangement } from '@/lib/layoutArrangement';
import {
  GROUP_IDS,
  MIN_RIGHT_PANEL_WIDTH,
  PANEL_IDS,
} from '@/stores/useLayoutStore';
import {
  BOTTOM_PANEL_IDS,
  getNextEditorGroupId,
  isBottomGroup,
  isEditorGroup,
  isLeftGroup,
  isSessionGroup,
  SESSION_PANEL_IDS,
} from '@/utils/dockviewGroupPolicy';
import { syncDockviewGroupRegistry } from '@/utils/dockviewHelpers';
import {
  DEFAULT_SESSION_PANEL_WIDTH,
  settleDockviewGroupWidths,
} from '@/utils/dockviewStartupSizing';
import { MIN_LEFT_PANEL_WIDTH } from '@/utils/dockviewWorkspaceConstraints';
import { collapsedEditorColumnWidths } from '@/utils/lastPreviewTabLayout';

/**
 * Dockview's built-in group minimum is 100px. Adding a group without
 * `initialWidth` uses that minimum as the size, which crushes the editor
 * column after the last tab is closed and the group is recreated.
 */
export const CRUSHED_EDITOR_COLUMN_WIDTH = 160;

/** Floor for the flexible workspace column when restoring side widths. */
export const MIN_EDITOR_COLUMN_WIDTH = 320;

type DockviewGroup = NonNullable<ReturnType<DockviewApi['getGroup']>>;

export interface EnsureWelcomeEditorGroupOptions {
  arrangement: LayoutArrangement;
  /** Session column width from before the editor group disappeared. */
  sessionWidth?: number;
  /** Dock column width from before the editor group disappeared. */
  dockWidth?: number;
}

function getLeftGroup(api: DockviewApi) {
  return (
    api.getGroup(GROUP_IDS.LEFT) ??
    api.groups.find((group) => isLeftGroup(group))
  );
}

function getBottomGroup(api: DockviewApi) {
  return (
    api.getGroup(GROUP_IDS.BOTTOM) ??
    api.groups.find((group) => isBottomGroup(group))
  );
}

function getRightGroup(api: DockviewApi) {
  return (
    api.getGroup(GROUP_IDS.RIGHT) ??
    api.groups.find((group) => isSessionGroup(group))
  );
}

function getEditorGroups(api: DockviewApi) {
  return api.groups.filter((group) => isEditorGroup(group));
}

function isSideColumn(slot: ReturnType<typeof slotOfZone>): boolean {
  return slot !== 'center' && slot !== 'bottom';
}

export function isEditorColumnCrushed(api: DockviewApi): boolean {
  const editorGroups = getEditorGroups(api).filter(
    (group) => group.api.isVisible
  );
  if (editorGroups.length === 0) return true;
  return editorGroups.every(
    (group) => group.api.width <= CRUSHED_EDITOR_COLUMN_WIDTH
  );
}

/**
 * The session column's live width is only meaningful while a flexible editor
 * column still exists. After the last editor tab closes, the session absorbs
 * the remainder — that expanded width must not be persisted as user intent.
 */
export function shouldPersistSessionColumnWidth(api: DockviewApi): boolean {
  return !isEditorColumnCrushed(api);
}

function defaultDockColumnWidth(gridWidth: number): number {
  return Math.max(MIN_LEFT_PANEL_WIDTH, Math.round(gridWidth * 0.1));
}

function intendedDockColumnWidth(
  gridWidth: number,
  currentWidth: number,
  preferredWidth?: number
): number {
  if (preferredWidth && preferredWidth >= MIN_LEFT_PANEL_WIDTH) {
    return preferredWidth;
  }

  const defaultWidth = defaultDockColumnWidth(gridWidth);
  const maxReasonableWidth = Math.max(defaultWidth * 2, gridWidth * 0.2);
  if (currentWidth > maxReasonableWidth) {
    return defaultWidth;
  }

  return Math.max(MIN_LEFT_PANEL_WIDTH, currentWidth);
}

/**
 * Re-apply dock and session column widths so the workspace editor absorbs
 * remaining space. Call after recreating a missing editor group: Dockview
 * otherwise seeds the new group at its 100px minimum, and the extra width
 * leaks into a side column.
 */
export function restoreFlexibleEditorColumn(
  api: DockviewApi,
  arrangement: LayoutArrangement,
  sessionWidth?: number,
  dockWidth?: number
): void {
  if (slotOfZone(arrangement, 'workspace') !== 'center') return;

  const leftGroup = getLeftGroup(api);
  const rightGroup = getRightGroup(api);
  const editorGroups = getEditorGroups(api).filter(
    (group) => group.api.isVisible
  );
  const editorGroup = editorGroups[0];
  if (
    editorGroups.length !== 1 ||
    !editorGroup ||
    !rightGroup?.api.isVisible ||
    !isSideColumn(slotOfZone(arrangement, 'session'))
  ) {
    return;
  }

  const leftIsSide =
    !!leftGroup?.api.isVisible && isSideColumn(slotOfZone(arrangement, 'dock'));
  const gridWidth = api.width;
  const nextDockWidth =
    leftIsSide && leftGroup
      ? intendedDockColumnWidth(gridWidth, leftGroup.api.width, dockWidth)
      : 0;
  const intendedSession = Math.max(
    MIN_RIGHT_PANEL_WIDTH,
    sessionWidth && sessionWidth > 0
      ? sessionWidth
      : DEFAULT_SESSION_PANEL_WIDTH
  );
  const maxSession = Math.max(
    MIN_RIGHT_PANEL_WIDTH,
    gridWidth - nextDockWidth - MIN_EDITOR_COLUMN_WIDTH
  );
  const nextSessionWidth = Math.min(intendedSession, maxSession);
  const nextEditorWidth = Math.max(
    MIN_EDITOR_COLUMN_WIDTH,
    gridWidth - nextDockWidth - nextSessionWidth
  );

  const targets: Array<{ group: DockviewGroup; width: number }> = [
    { group: editorGroup, width: nextEditorWidth },
    { group: rightGroup, width: nextSessionWidth },
  ];
  if (leftIsSide && leftGroup) {
    targets.push({ group: leftGroup, width: nextDockWidth });
  }

  settleDockviewGroupWidths(targets);
}

/**
 * After the last editor tab closes, keep a hidden editor group as an anchor
 * and give the leftover width to the session column instead of leaving a
 * crushed Welcome pane.
 */
export function dismissEmptyEditorColumn(
  api: DockviewApi,
  options: EnsureWelcomeEditorGroupOptions
): DockviewGroup | undefined {
  const group = ensureWelcomeEditorGroup(api, options);
  group?.api.setVisible(false);
  absorbHiddenEditorColumn(api, options.arrangement, options.dockWidth);
  return group;
}

export function absorbHiddenEditorColumn(
  api: DockviewApi,
  arrangement: LayoutArrangement,
  dockWidth?: number
): void {
  if (slotOfZone(arrangement, 'workspace') !== 'center') return;

  const leftGroup = getLeftGroup(api);
  const rightGroup = getRightGroup(api);
  if (
    !rightGroup?.api.isVisible ||
    !isSideColumn(slotOfZone(arrangement, 'session'))
  ) {
    return;
  }

  const leftIsSide =
    !!leftGroup?.api.isVisible && isSideColumn(slotOfZone(arrangement, 'dock'));
  const gridWidth = api.width;
  const nextDockWidth =
    leftIsSide && leftGroup
      ? intendedDockColumnWidth(gridWidth, leftGroup.api.width, dockWidth)
      : 0;
  const widths = collapsedEditorColumnWidths({
    gridWidth,
    dockWidth: nextDockWidth,
    minDockWidth: MIN_LEFT_PANEL_WIDTH,
    minSessionWidth: MIN_RIGHT_PANEL_WIDTH,
  });

  const targets: Array<{ group: DockviewGroup; width: number }> = [
    { group: rightGroup, width: widths.session },
  ];
  if (leftIsSide && leftGroup) {
    targets.push({ group: leftGroup, width: widths.dock });
  }
  settleDockviewGroupWidths(targets);
}

export function ensureWelcomeEditorGroup(
  api: DockviewApi,
  options: EnsureWelcomeEditorGroupOptions
): DockviewGroup | undefined {
  const editorGroups = getEditorGroups(api);
  if (editorGroups.length > 0) {
    const existing = editorGroups[0];
    if (
      existing &&
      existing.panels.length === 0 &&
      !api.getPanel(PANEL_IDS.WELCOME)
    ) {
      api.addPanel({
        id: PANEL_IDS.WELCOME,
        component: PANEL_IDS.WELCOME,
        title: 'Welcome',
        position: { referenceGroup: existing, direction: 'within' },
        inactive: true,
      });
    }
    if (isEditorColumnCrushed(api)) {
      restoreFlexibleEditorColumn(
        api,
        options.arrangement,
        options.sessionWidth,
        options.dockWidth
      );
    }
    return existing;
  }

  const existingWelcome = api.getPanel(PANEL_IDS.WELCOME);
  if (existingWelcome) {
    if (isEditorColumnCrushed(api)) {
      restoreFlexibleEditorColumn(
        api,
        options.arrangement,
        options.sessionWidth,
        options.dockWidth
      );
    }
    return existingWelcome.group;
  }

  const bottomGroup = getBottomGroup(api);
  const bottomReferencePanel = bottomGroup?.panels[0];
  const leftGroup = getLeftGroup(api);
  const rightGroup = getRightGroup(api);
  const referencePanel =
    bottomReferencePanel ??
    leftGroup?.panels[0] ??
    api.panels.find(
      (panel) =>
        !BOTTOM_PANEL_IDS.has(panel.id) && !SESSION_PANEL_IDS.has(panel.id)
    );

  const leftWidth =
    leftGroup?.api.isVisible &&
    isSideColumn(slotOfZone(options.arrangement, 'dock'))
      ? leftGroup.api.width
      : 0;
  const intendedSession = Math.max(
    MIN_RIGHT_PANEL_WIDTH,
    options.sessionWidth && options.sessionWidth > 0
      ? options.sessionWidth
      : rightGroup?.api.isVisible
        ? DEFAULT_SESSION_PANEL_WIDTH
        : 0
  );
  const initialWidth = Math.max(
    MIN_EDITOR_COLUMN_WIDTH,
    api.width - leftWidth - intendedSession
  );

  const welcomePanel = api.addPanel({
    id: PANEL_IDS.WELCOME,
    component: PANEL_IDS.WELCOME,
    title: 'Welcome',
    initialWidth,
    ...(referencePanel
      ? {
          position: {
            referencePanel,
            direction: bottomReferencePanel
              ? ('above' as const)
              : leftGroup
                ? ('right' as const)
                : ('within' as const),
          },
        }
      : {}),
    inactive: true,
  });

  (welcomePanel.group as { id: string }).id = getNextEditorGroupId(api);
  syncDockviewGroupRegistry(api);
  restoreFlexibleEditorColumn(
    api,
    options.arrangement,
    options.sessionWidth,
    options.dockWidth
  );
  return welcomePanel.group;
}
