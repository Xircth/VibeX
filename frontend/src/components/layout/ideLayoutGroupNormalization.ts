import i18n from '@/i18n';
import type { DockviewApi } from 'dockview-react';
import {
  ACTIVITY_RAIL_PANEL_TITLES,
  getDefaultActivityRailPanelId,
} from '@/lib/activityRailOrder';
import {
  getLayoutArrangement,
  type LayoutArrangement,
  type LayoutZone,
} from '@/lib/layoutArrangement';
import { terminalShelfGroupId } from '@/lib/terminalShelf';
import { syncWorkspaceOpenSessionIdsFromDockview } from '@/lib/workspaceSessionTabSlots';
import {
  EDITOR_GROUP_PREFIX,
  GROUP_IDS,
  MIN_RIGHT_PANEL_WIDTH,
  PANEL_IDS,
  useLayoutStore,
} from '@/stores/useLayoutStore';
import {
  dismissEmptyEditorColumn,
  ensureWelcomeEditorGroup,
  preserveLeftDockGroupWidths,
  restoreFlexibleEditorColumn,
  setColumnVisible,
  setLeftDockVisible,
} from '@/utils/dockviewEditorGroup';
import {
  compareEditorGroups,
  getGroupElement,
  getNextEditorGroupId,
  getNextLeftGroupId,
  getNextRightGroupId,
  isBottomGroup,
  isEditorGroup,
  isLeftGroup,
  isSessionGroup,
  isSessionPanelId,
  LEFT_GROUP_PREFIX,
  LEFT_PANEL_IDS,
  listLeftDockGroups,
  listSessionGroups,
  RIGHT_GROUP_PREFIX,
} from '@/utils/dockviewGroupPolicy';
import {
  assignDockviewGroupIdAndRole,
  setDockviewGroupRole,
  syncDockviewGroupRegistry,
} from '@/utils/dockviewGroupRole';
import { applyLeftGroupHeaderHiding } from '@/utils/dockviewHelpers';
import {
  addSessionPanelWithoutStealingFocus,
  isDockviewApiDisposed,
  revealSessionPanelWithoutStealingFocus,
} from '@/utils/dockviewSessionPanel';
import {
  defaultSessionPanelWidth,
  settleDockviewGroupWidths,
} from '@/utils/dockviewStartupSizing';
import {
  applyWorkspaceZoneConstraints,
  MIN_LEFT_PANEL_WIDTH,
} from '@/utils/dockviewWorkspaceConstraints';
import {
  releaseLegacyTerminalZones,
  rememberTerminalShelfFromApi,
} from '@/utils/terminalZoneRelease';

export const IDE_LAYOUT_SIZING = {
  // A (dock) defaults to 10% of the full grid; C (session) uses the shared
  // fixed default calculated by defaultSessionPanelWidth. Users can resize
  // either column above its usable minimum; that choice persists verbatim.
  LEFT_PANEL_DEFAULT_RATIO: 0.1,
  LEFT_PANEL_MIN_WIDTH: MIN_LEFT_PANEL_WIDTH,
  LAYOUT_CHANGE_DEBOUNCE_MS: 500,
  IDLE_PERSIST_TIMEOUT_MS: 1000,
} as const;

/**
 * Default widths, floored at each zone's usable minimum for small windows.
 */
export function defaultDockWidth(gridWidth: number): number {
  return Math.max(
    IDE_LAYOUT_SIZING.LEFT_PANEL_MIN_WIDTH,
    Math.round(gridWidth * IDE_LAYOUT_SIZING.LEFT_PANEL_DEFAULT_RATIO)
  );
}

export function defaultSessionWidth(gridWidth: number): number {
  return defaultSessionPanelWidth(gridWidth, MIN_RIGHT_PANEL_WIDTH);
}

export type DockviewGroup = NonNullable<ReturnType<DockviewApi['getGroup']>>;

export function getLeftGroup(api: DockviewApi): DockviewGroup | undefined {
  return (
    api.getGroup(GROUP_IDS.LEFT) ??
    api.groups.find(
      (group) =>
        isLeftGroup(group) &&
        group.element?.getAttribute('data-shell-nav-side') !== 'right'
    ) ??
    api.groups.find((group) => isLeftGroup(group))
  );
}

export function getBottomGroup(api: DockviewApi): DockviewGroup | undefined {
  return (
    api.getGroup(GROUP_IDS.BOTTOM) ??
    api.groups.find((group) => isBottomGroup(group))
  );
}

export function getRightGroup(api: DockviewApi): DockviewGroup | undefined {
  return (
    api.getGroup(GROUP_IDS.RIGHT) ??
    api.groups.find((group) => isSessionGroup(group))
  );
}

export function getEditorGroups(api: DockviewApi): DockviewGroup[] {
  return api.groups
    .filter((group) => isEditorGroup(group))
    .sort(compareEditorGroups);
}

export function zoneGroup(
  api: DockviewApi,
  zone: LayoutZone
): DockviewGroup | undefined {
  switch (zone) {
    case 'dock':
      return getLeftGroup(api);
    case 'terminal':
      return getBottomGroup(api);
    case 'session':
      return getRightGroup(api);
    case 'workspace':
      return getEditorGroups(api)[0];
  }
}

/**
 * Verify the visible zone groups appear left-to-right in the order the
 * arrangement prescribes. Ad-hoc group re-creation paths (e.g. restoring the
 * dock next to the editor) can scramble the column order; a mismatch here
 * triggers a re-apply of the arrangement, which normalizes the grid.
 */
export function zoneOrderMatchesArrangement(
  api: DockviewApi,
  arrangement: LayoutArrangement
): boolean {
  const leftGroups = listLeftDockGroups(api.groups);
  const skipDockCheck =
    leftGroups.length > 1 ||
    leftGroups.some(
      (group) => group.element?.getAttribute('data-shell-nav-side') === 'right'
    );

  let previousLeft = Number.NEGATIVE_INFINITY;
  for (const slot of ['left', 'center', 'right'] as const) {
    const zone = arrangement[slot];
    if (zone === 'dock' && skipDockCheck) continue;

    const group = zoneGroup(api, zone);
    if (!group?.api.isVisible) continue;

    const rect = getGroupElement(group)?.getBoundingClientRect();
    if (!rect || rect.width <= 0) continue;

    if (rect.left <= previousLeft) return false;
    previousLeft = rect.left;
  }
  return true;
}

export function normalizeGroupIds(api: DockviewApi): void {
  releaseLegacyTerminalZones(api);
  rememberTerminalShelfFromApi(api);

  const leftGroups = listLeftDockGroups(api.groups);
  if (leftGroups.length > 0) {
    const primary =
      leftGroups.find(
        (group) =>
          group.id === GROUP_IDS.LEFT &&
          group.element?.getAttribute('data-shell-nav-side') !== 'right'
      ) ??
      leftGroups.find(
        (group) =>
          group.element?.getAttribute('data-shell-nav-side') !== 'right'
      ) ??
      leftGroups[0];

    const primaryUsesCanonicalLeftId = Boolean(
      primary &&
        primary.element?.getAttribute('data-shell-nav-side') !== 'right'
    );

    if (primaryUsesCanonicalLeftId) {
      for (const group of leftGroups) {
        if (group !== primary && group.id === GROUP_IDS.LEFT) {
          assignDockviewGroupIdAndRole(
            api,
            group,
            getNextLeftGroupId(api),
            'left'
          );
        }
      }
      if (primary) {
        assignDockviewGroupIdAndRole(api, primary, GROUP_IDS.LEFT, 'left');
      }
    }

    for (const group of leftGroups) {
      if (group === primary && primaryUsesCanonicalLeftId) {
        continue;
      }
      const nextLeftId = group.id.startsWith(LEFT_GROUP_PREFIX)
        ? group.id
        : getNextLeftGroupId(api);
      assignDockviewGroupIdAndRole(api, group, nextLeftId, 'left');
    }
  }

  const sessionGroups = listSessionGroups(api.groups);
  if (sessionGroups.length > 0) {
    const primary =
      sessionGroups.find((group) => group.id === GROUP_IDS.RIGHT) ??
      sessionGroups[0];
    if (primary) {
      assignDockviewGroupIdAndRole(api, primary, GROUP_IDS.RIGHT, 'session');
    }
    for (const group of sessionGroups) {
      if (group === primary) continue;
      const nextRightId = group.id.startsWith(RIGHT_GROUP_PREFIX)
        ? group.id
        : getNextRightGroupId(api);
      assignDockviewGroupIdAndRole(api, group, nextRightId, 'session');
    }
  }

  for (const group of api.groups) {
    if (isBottomGroup(group)) {
      assignDockviewGroupIdAndRole(api, group, GROUP_IDS.BOTTOM, 'bottom');
      continue;
    }
    if (isEditorGroup(group)) {
      if (group.panels.length > 0) {
        const nextEditorId = group.id.startsWith(EDITOR_GROUP_PREFIX)
          ? group.id
          : getNextEditorGroupId(api);
        assignDockviewGroupIdAndRole(api, group, nextEditorId, 'editor');
      } else if (group.id.startsWith(EDITOR_GROUP_PREFIX)) {
        setDockviewGroupRole(group, 'editor');
      }
    }
  }

  syncDockviewGroupRegistry(api);
  applyLeftGroupHeaderHiding(api);
  applyWorkspaceZoneConstraints(api);
  syncWorkspaceOpenSessionIdsFromDockview(api);
}

export function buildDefaultLayout(api: DockviewApi): void {
  const welcomePanel = api.addPanel({
    id: PANEL_IDS.WELCOME,
    component: PANEL_IDS.WELCOME,
    title: i18n.t('panels:panelRegistry.welcome', { defaultValue: 'Welcome' }),
    renderer: 'onlyWhenVisible',
  });
  assignDockviewGroupIdAndRole(
    api,
    welcomePanel.group,
    `${EDITOR_GROUP_PREFIX}1`,
    'editor'
  );

  const leftGroup = api.addGroup({
    id: GROUP_IDS.LEFT,
    referencePanel: welcomePanel,
    direction: 'left',
    hideHeader: true,
    constraints: { minimumWidth: IDE_LAYOUT_SIZING.LEFT_PANEL_MIN_WIDTH },
    initialWidth: defaultDockWidth(api.width),
  });
  setDockviewGroupRole(leftGroup, 'left');

  const defaultLeftPanelId = getDefaultActivityRailPanelId();
  api.addPanel({
    id: defaultLeftPanelId,
    component: defaultLeftPanelId,
    title: ACTIVITY_RAIL_PANEL_TITLES[defaultLeftPanelId],
    renderer: 'onlyWhenVisible',
    position: {
      referenceGroup: leftGroup,
      direction: 'within',
    },
  });

  if (useLayoutStore.getState().isRightPanelVisible) {
    const rightGroup = api.addGroup({
      id: GROUP_IDS.RIGHT,
      referencePanel: welcomePanel,
      direction: 'right',
      constraints: { minimumWidth: MIN_RIGHT_PANEL_WIDTH },
      initialWidth: defaultSessionWidth(api.width),
    });
    setDockviewGroupRole(rightGroup, 'session');

    addSessionPanelWithoutStealingFocus(api, rightGroup);

    normalizeGroupIds(api);
    settleDockviewGroupWidths([
      { group: leftGroup, width: defaultDockWidth(api.width) },
      { group: rightGroup, width: defaultSessionWidth(api.width) },
    ]);
    return;
  }

  normalizeGroupIds(api);
  settleDockviewGroupWidths([
    { group: leftGroup, width: defaultDockWidth(api.width) },
  ]);
}

export function recreateWelcomeEditorGroup(
  api: DockviewApi
): DockviewGroup | undefined {
  const leftGroup = getLeftGroup(api);
  const group = ensureWelcomeEditorGroup(api, {
    arrangement: getLayoutArrangement(),
    sessionWidth: useLayoutStore.getState().rightPanelWidth,
    dockWidth: leftGroup?.api.isVisible ? leftGroup.api.width : undefined,
  });
  normalizeGroupIds(api);
  return group;
}

export function dismissEditorColumnAfterLastTab(api: DockviewApi): void {
  const leftGroup = getLeftGroup(api);
  dismissEmptyEditorColumn(api, {
    arrangement: getLayoutArrangement(),
    sessionWidth: useLayoutStore.getState().rightPanelWidth,
    dockWidth: leftGroup?.api.isVisible ? leftGroup.api.width : undefined,
  });
  normalizeGroupIds(api);
}

export function ensureDockviewSessionPanel(
  api: DockviewApi
): DockviewGroup | undefined {
  if (isDockviewApiDisposed(api)) {
    return undefined;
  }

  let rightGroup = getRightGroup(api);
  if (!rightGroup) {
    const editorGroup =
      getEditorGroups(api)[0] ?? recreateWelcomeEditorGroup(api);
    const referencePanel = editorGroup?.panels[0];
    if (!referencePanel) return undefined;

    rightGroup = preserveLeftDockGroupWidths(api, () =>
      api.addGroup({
        id: GROUP_IDS.RIGHT,
        referencePanel,
        direction: 'right',
        constraints: { minimumWidth: MIN_RIGHT_PANEL_WIDTH },
        initialWidth: defaultSessionWidth(api.width),
      })
    );
    setDockviewGroupRole(rightGroup, 'session');
  }

  const sessionGroups = listSessionGroups(api.groups);
  const existingSessionPanel =
    api.getPanel(PANEL_IDS.AI_CHAT) ??
    api.panels.find((panel) => isSessionPanelId(panel.id)) ??
    sessionGroups.find((group) => group.panels.length > 0)?.panels[0];

  if (existingSessionPanel) {
    revealSessionPanelWithoutStealingFocus(existingSessionPanel);
  } else {
    addSessionPanelWithoutStealingFocus(api, rightGroup);
  }

  normalizeGroupIds(api);
  return rightGroup;
}

export function restoreWorkspaceDockviewPanels(
  api: DockviewApi,
  options: {
    effectiveActiveTab: string;
    effectiveWorkspaceId: string | null;
    terminalVisibleBeforeKanbanRef: { current: boolean | null };
  }
): void {
  if (isDockviewApiDisposed(api)) {
    return;
  }
  if (
    options.effectiveActiveTab !== 'workspace' &&
    !options.effectiveWorkspaceId
  ) {
    return;
  }

  let leftGroup = getLeftGroup(api);
  if (!leftGroup) {
    const editorGroup =
      getEditorGroups(api)[0] ?? recreateWelcomeEditorGroup(api);
    const referencePanel = editorGroup?.panels[0];
    if (!referencePanel) return;

    leftGroup = api.addGroup({
      id: GROUP_IDS.LEFT,
      referencePanel,
      direction: 'left',
      hideHeader: true,
      constraints: { minimumWidth: IDE_LAYOUT_SIZING.LEFT_PANEL_MIN_WIDTH },
      initialWidth: defaultDockWidth(api.width),
    });
    setDockviewGroupRole(leftGroup, 'left');
  }

  const hasLeftPanel = [...LEFT_PANEL_IDS].some((panelId) =>
    api.getPanel(panelId)
  );
  if (!hasLeftPanel) {
    const defaultLeftPanelId = getDefaultActivityRailPanelId();
    api.addPanel({
      id: defaultLeftPanelId,
      component: defaultLeftPanelId,
      title: ACTIVITY_RAIL_PANEL_TITLES[defaultLeftPanelId],
      renderer: 'onlyWhenVisible',
      position: {
        referenceGroup: GROUP_IDS.LEFT,
        direction: 'within',
      },
    });
  }

  setLeftDockVisible(api, getLayoutArrangement(), true);

  const hasVisibleEditorPanels = getEditorGroups(api).some(
    (group) => group.api.isVisible && group.panels.length > 0
  );
  const hasVisibleSessionPanels = listSessionGroups(api.groups).some(
    (group) => group.api.isVisible && group.panels.length > 0
  );
  if (!hasVisibleEditorPanels && !hasVisibleSessionPanels) {
    const dockWidthBefore = leftGroup?.api.isVisible
      ? leftGroup.api.width
      : undefined;
    const welcomeGroup = recreateWelcomeEditorGroup(api);
    if (welcomeGroup) {
      setColumnVisible(api, getLayoutArrangement(), welcomeGroup, true);
      restoreFlexibleEditorColumn(
        api,
        getLayoutArrangement(),
        useLayoutStore.getState().rightPanelWidth,
        dockWidthBefore
      );
    }
  }

  const restoredFromKanban = options.terminalVisibleBeforeKanbanRef.current;
  options.terminalVisibleBeforeKanbanRef.current = null;
  const shelfId = terminalShelfGroupId();
  const shelf = shelfId ? api.getGroup(shelfId) : undefined;
  if (
    shelf &&
    restoredFromKanban !== null &&
    shelf.api.isVisible !== restoredFromKanban
  ) {
    shelf.api.setVisible(restoredFromKanban);
  }
  normalizeGroupIds(api);
}
