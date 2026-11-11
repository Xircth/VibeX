import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import i18n from '@/i18n';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from 'dockview-react';
import type { DockviewWillShowOverlayLocationEvent } from 'dockview-core';
import {
  WorkspaceDockviewTab,
  panelComponents,
} from '@/components/layout/panels/PanelRegistry';
import { WorkspaceActivityRail } from '@/components/layout/WorkspaceActivityRail';
import { WorkspaceTabAddMenu } from '@/components/layout/panels/WorkspaceTabAddMenu';
import { useViews } from '@vibex/plugin-sdk';
import { useUserSystem } from '@/components/ConfigProvider';
import { PluginOverlays } from '@/components/plugins/PluginOverlays';
import { PluginRemoteView } from '@/components/plugins/PluginRemoteView';
import { useActiveSurfaceHidesBottomDock } from '@/hooks/useActiveSurfaceDockPolicy';
import { useAutoOpenCreatedFilePreviews } from '@/hooks/useAutoOpenCreatedFilePreviews';
import { useAutoOpenCreatedPreviews } from '@/lib/autoOpenCreatedPreviews';
import { usePluginHostContributions } from '@/hooks/usePluginHostContributions';
import {
  effectiveWorkspaceTab,
  parsePluginSurfaceId,
} from '@/lib/hostSurfaceIds';
import { MobileDeviceConnectBanner } from '@/components/layout/MobileDeviceConnectBanner';
import { StatusBar } from '@/components/layout/StatusBar';
import { WorkspaceZeroProjectStage } from '@/components/layout/WorkspaceZeroProjectStage';
import { ProjectLayoutScope, useProject } from '@/contexts/ProjectContext';
import {
  EDITOR_GROUP_PREFIX,
  GROUP_IDS,
  MAX_EDITOR_GROUPS,
  MIN_RIGHT_PANEL_WIDTH,
  PANEL_IDS,
  useLayoutStore,
} from '@/stores/useLayoutStore';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  RightPanelSlotContext,
  type SessionPanelPlacement,
} from '@/contexts/RightPanelSlotContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useProjectWorktrees } from '@/hooks/useProjectWorktrees';
import { getProjectScopeKey } from '@/lib/projectScope';
import { resolveSurfaceWorkspaceId } from '@/lib/surfaceWorkspace';
import { useProjectViewStateStore } from '@/stores/useProjectViewStateStore';
import { useAgentLongRunningTerminals } from '@/hooks/useAgentLongRunningTerminals';
import { useWorkspaceOverlay } from '@/contexts/WorkspaceOverlayContext';
import { chromeHidesNativeSurface } from '@/lib/nativeSurfaceHandoff';
import { KeepAliveSurface } from '@/components/layout/KeepAliveSurface';
import { KANBAN_INACTIVE_EVICT_MS } from '@/components/layout/kanbanKeepAlive';
import {
  applyLeftGroupHeaderHiding,
  syncDockviewGroupRegistry,
} from '@/utils/dockviewHelpers';
import {
  applyWorkspaceZoneConstraints,
  MIN_LEFT_PANEL_WIDTH,
} from '@/utils/dockviewWorkspaceConstraints';
import {
  dismissEmptyEditorColumn,
  ensureWelcomeEditorGroup,
  installEditorColumnWidthRebalance,
  restoreFlexibleEditorColumn,
  setColumnVisible,
  setLeftDockVisible,
  setSessionDockVisible,
  setColumnsVisible,
  shouldPersistSessionColumnWidth,
} from '@/utils/dockviewEditorGroup';
import {
  groupsHiddenWhenEditorAreaCollapsed,
  shouldDismissEditorColumnAfterPanelRemoval,
} from '@/utils/lastPreviewTabLayout';
import { DEFAULT_TERMINAL_PANEL_HEIGHT } from '@/lib/terminalPreferences';
import {
  addSessionPanelWithoutStealingFocus,
  revealSessionPanelWithoutStealingFocus,
} from '@/utils/dockviewSessionPanel';
import {
  isTerminalShelfGroup,
  isTerminalShelfOpen,
  terminalShelfGroupId,
} from '@/lib/terminalShelf';
import {
  releaseLegacyTerminalZones,
  rememberTerminalShelfFromApi,
} from '@/utils/terminalZoneRelease';
import {
  ACTIVITY_RAIL_PANEL_TITLES,
  getDefaultActivityRailPanelId,
} from '@/lib/activityRailOrder';
import {
  arrangementsEqual,
  getLayoutArrangement,
  isDefaultArrangement,
  slotOfZone,
  useLayoutArrangement,
  type LayoutArrangement,
  type LayoutZone,
} from '@/lib/layoutArrangement';
import {
  arrangeSerializedLayout,
  serializedLayoutMatchesArrangement,
  type ArrangeLayoutOptions,
} from '@/utils/dockviewLayoutTransform';
import { SearchPalette } from '@/components/search/SearchPalette';
import { useWorkspaceShortcuts } from '@/hooks/useWorkspaceShortcuts';
import {
  BOTTOM_PANEL_IDS,
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
  isPlaceholderPanelId,
  LEFT_GROUP_PREFIX,
  LEFT_PANEL_IDS,
  listLeftDockGroups,
  listSessionGroups,
  RIGHT_GROUP_PREFIX,
} from '@/utils/dockviewGroupPolicy';
import { installDockviewPointerTabDnd } from '@/utils/dockviewPointerTabDnd';
import { syncWorkspaceOpenSessionIdsFromDockview } from '@/lib/workspaceSessionTabSlots';
import '@/styles/dockview-ayu.css';
import {
  defaultSessionPanelWidth,
  layoutDockviewPreservingGroupWidths,
  settleDockviewGroupWidths,
} from '@/utils/dockviewStartupSizing';
import { useWorkspaceStageStyle } from '@/lib/workspaceStageStyle';
import { CollaborationSpaceProvider } from '@/features/collaboration/space/SpaceContext';
import {
  findCanvasBoundarySash,
  measureCanvasStageInsets,
  type CanvasStageInsets,
} from '@/components/layout/canvasStageInsets';

const LAYOUT = {
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
function defaultDockWidth(gridWidth: number): number {
  return Math.max(
    LAYOUT.LEFT_PANEL_MIN_WIDTH,
    Math.round(gridWidth * LAYOUT.LEFT_PANEL_DEFAULT_RATIO)
  );
}

function defaultSessionWidth(gridWidth: number): number {
  return defaultSessionPanelWidth(gridWidth, MIN_RIGHT_PANEL_WIDTH);
}

type DockviewGroup = NonNullable<ReturnType<DockviewApi['getGroup']>>;

interface IDELayoutProps {
  rightPanelContent?: ReactNode;
  toolbarContent?: ReactNode;
}

const LazyKanbanBoard = lazy(() =>
  import('@/components/panels/DockviewKanbanPanel').then((module) => ({
    default: module.KanbanBoard,
  }))
);

const LazyWorkspaceCanvasStage = lazy(() =>
  import('@/components/kanban/KanbanSessionHub').then((module) => ({
    default: module.KanbanSessionHub,
  }))
);

function getLeftGroup(api: DockviewApi): DockviewGroup | undefined {
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

function getBottomGroup(api: DockviewApi): DockviewGroup | undefined {
  return (
    api.getGroup(GROUP_IDS.BOTTOM) ??
    api.groups.find((group) => isBottomGroup(group))
  );
}

function getRightGroup(api: DockviewApi): DockviewGroup | undefined {
  return (
    api.getGroup(GROUP_IDS.RIGHT) ??
    api.groups.find((group) => isSessionGroup(group))
  );
}

function zoneGroup(
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
    default:
      return getEditorGroups(api)[0];
  }
}

/**
 * Verify the visible zone groups appear left-to-right in the order the
 * arrangement prescribes. Ad-hoc group re-creation paths (e.g. restoring the
 * dock next to the editor) can scramble the column order; a mismatch here
 * triggers a re-apply of the arrangement, which normalizes the grid.
 */
function zoneOrderMatchesArrangement(
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

function getEditorGroups(api: DockviewApi): DockviewGroup[] {
  return api.groups
    .filter((group) => isEditorGroup(group))
    .sort(compareEditorGroups);
}

function normalizeGroupIds(api: DockviewApi) {
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
    if (
      primary &&
      primary.element?.getAttribute('data-shell-nav-side') !== 'right'
    ) {
      (primary as { id: string }).id = GROUP_IDS.LEFT;
    }
    for (const group of leftGroups) {
      if (
        group === primary &&
        group.element?.getAttribute('data-shell-nav-side') !== 'right'
      ) {
        continue;
      }
      if (!group.id.startsWith(LEFT_GROUP_PREFIX)) {
        (group as { id: string }).id = getNextLeftGroupId(api);
      }
    }
  }

  const sessionGroups = listSessionGroups(api.groups);
  if (sessionGroups.length > 0) {
    const primary =
      sessionGroups.find((group) => group.id === GROUP_IDS.RIGHT) ??
      sessionGroups[0];
    (primary as { id: string }).id = GROUP_IDS.RIGHT;
    for (const group of sessionGroups) {
      if (group === primary) continue;
      if (!group.id.startsWith(RIGHT_GROUP_PREFIX)) {
        (group as { id: string }).id = getNextRightGroupId(api);
      }
    }
  }

  for (const group of api.groups) {
    if (
      isEditorGroup(group) &&
      group.panels.length > 0 &&
      !group.id.startsWith(EDITOR_GROUP_PREFIX)
    ) {
      (group as { id: string }).id = getNextEditorGroupId(api);
    }
  }

  syncDockviewGroupRegistry(api);
  applyLeftGroupHeaderHiding(api);
  applyWorkspaceZoneConstraints(api);
  syncWorkspaceOpenSessionIdsFromDockview(api);
}

function buildDefaultLayout(api: DockviewApi) {
  const welcomePanel = api.addPanel({
    id: PANEL_IDS.WELCOME,
    component: PANEL_IDS.WELCOME,
    title: i18n.t('panels:panelRegistry.welcome', { defaultValue: 'Welcome' }),
    renderer: 'onlyWhenVisible',
  });
  (welcomePanel.group as { id: string }).id = `${EDITOR_GROUP_PREFIX}1`;

  const leftGroup = api.addGroup({
    id: GROUP_IDS.LEFT,
    referencePanel: welcomePanel,
    direction: 'left',
    hideHeader: true,
    constraints: { minimumWidth: LAYOUT.LEFT_PANEL_MIN_WIDTH },
    initialWidth: defaultDockWidth(api.width),
  });

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

function recreateWelcomeEditorGroup(
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

function dismissEditorColumnAfterLastTab(api: DockviewApi): void {
  const leftGroup = getLeftGroup(api);
  dismissEmptyEditorColumn(api, {
    arrangement: getLayoutArrangement(),
    sessionWidth: useLayoutStore.getState().rightPanelWidth,
    dockWidth: leftGroup?.api.isVisible ? leftGroup.api.width : undefined,
  });
  normalizeGroupIds(api);
}

export function IDELayout({
  rightPanelContent,
  toolbarContent,
}: IDELayoutProps) {
  useAgentLongRunningTerminals();
  const {
    projectId: routeProjectId,
    workspaceId,
    sessionId,
  } = useParams<{
    projectId?: string;
    workspaceId?: string;
    sessionId?: string;
  }>();
  const apiRef = useRef<DockviewApi | null>(null);
  const dockviewRootRef = useRef<HTMLDivElement>(null);
  const { activeWorktreeId } = useWorktree();
  const { projectId: contextProjectId } = useProject();
  const projectId = contextProjectId ?? routeProjectId;
  const projectKey = getProjectScopeKey(projectId);
  const rememberedWorkspaceId = useProjectViewStateStore(
    (state) => state.kanbanByProject[projectKey]?.lastActiveWorkspaceId ?? null
  );
  const { worktrees } = useProjectWorktrees(projectId);
  const {
    serializedLayout,
    setSerializedLayout,
    isRightPanelVisible,
    setRightPanelWidth,
    isEditorAreaVisible,
    toggleEditorArea,
    activeTab,
  } = useLayoutStore();
  const arrangement = useLayoutArrangement();
  const effectiveWorkspaceId = activeWorktreeId ?? workspaceId ?? null;
  const surfaceWorkspaceId = useMemo(
    () =>
      resolveSurfaceWorkspaceId({
        routeWorkspaceId: workspaceId,
        activeWorkspaceId: activeWorktreeId,
        rememberedWorkspaceId,
        workspaces: worktrees.map((item) => item.workspace),
      }),
    [activeWorktreeId, rememberedWorkspaceId, workspaceId, worktrees]
  );
  const { config } = useUserSystem();
  const routeTab = workspaceId || sessionId ? 'workspace' : null;
  const effectiveActiveTab = effectiveWorkspaceTab(routeTab, activeTab, {
    collaborationEnabled: Boolean(config?.multi_agent_enabled),
  });
  const hasProject = Boolean(projectId);
  const [isDockviewMounted, setIsDockviewMounted] = useState(
    () => hasProject && effectiveActiveTab === 'workspace'
  );
  useEffect(() => {
    if (!hasProject) {
      apiRef.current = null;
      setIsDockviewMounted(false);
      return;
    }
    if (effectiveActiveTab === 'workspace') {
      setIsDockviewMounted(true);
    }
  }, [effectiveActiveTab, hasProject]);
  const hidesBottomDock = useActiveSurfaceHidesBottomDock(effectiveActiveTab);
  const pluginTabs = usePluginHostContributions('app_tab');
  const sdkViews = useViews();
  const activeSdkTabView = useMemo(
    () =>
      sdkViews.find(
        (view) =>
          (view.kind === 'tab' || view.slot === 'tab.main') &&
          Boolean(view.component) &&
          (view.id === effectiveActiveTab ||
            (view.pluginId &&
              (`${view.pluginId}:${effectiveActiveTab}` === view.id ||
                `plugin:${view.pluginId}/${effectiveActiveTab}` === view.id)))
      ) ?? null,
    [effectiveActiveTab, sdkViews]
  );
  const ActiveSdkTabComponent = activeSdkTabView?.component as
    | ComponentType<{
        workspaceId?: string | null;
        projectId?: string | null;
      }>
    | undefined;
  const activePluginTab = (() => {
    const parsed = parsePluginSurfaceId(effectiveActiveTab);
    if (!parsed) return null;
    const catalogMatch = pluginTabs.find(
      (item) =>
        item.pluginId === parsed.pluginId && item.id === parsed.contributionId
    );
    if (catalogMatch) return catalogMatch;
    const sdkMatch = sdkViews.find(
      (view) =>
        view.kind === 'tab' &&
        view.pluginId === parsed.pluginId &&
        (view.id === parsed.contributionId ||
          view.id === `${parsed.pluginId}:${parsed.contributionId}` ||
          view.id === `plugin:${parsed.pluginId}/${parsed.contributionId}`)
    );
    if (!sdkMatch) return null;
    return {
      pluginId: parsed.pluginId,
      id: parsed.contributionId,
      kind: 'app_tab' as const,
      label: sdkMatch.title,
      generation: 1,
      metadata: sdkMatch.icon ? { icon: sdkMatch.icon } : {},
    };
  })();
  const serializedLayoutRef = useRef(serializedLayout);
  const layoutChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const isResettingRef = useRef(false);
  const currentLayoutProject = useLayoutStore(
    (state) => state.currentProjectKey
  );
  const isLayoutScopeReady = currentLayoutProject === projectKey;
  const prevSerializedLayoutRef = useRef<{
    projectKey: string;
    serializedLayout: typeof serializedLayout;
  }>({
    projectKey: currentLayoutProject,
    serializedLayout,
  });
  const appliedArrangementRef = useRef<LayoutArrangement | null>(null);
  const lastSelfHealAtRef = useRef(0);
  // Detached element hosting the session (C zone) content; the workspace
  // dockview panel and the kanban session slot re-parent it between them.
  const [sessionContentHost] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const element = document.createElement('div');
    element.className = 'h-full w-full min-w-0 overflow-hidden';
    return element;
  });

  const { setDockviewApi } = usePanelActionsContext();
  const [readyDockviewApi, setReadyDockviewApi] = useState<DockviewApi | null>(
    null
  );
  if (!isLayoutScopeReady && apiRef.current !== null) {
    apiRef.current = null;
  }

  const autoOpenCreatedPreviews = useAutoOpenCreatedPreviews();
  useAutoOpenCreatedFilePreviews({
    enabled:
      effectiveActiveTab === 'workspace' &&
      isEditorAreaVisible &&
      autoOpenCreatedPreviews,
  });

  serializedLayoutRef.current = serializedLayout;
  const isWorkspaceEditorAreaCollapsed =
    effectiveActiveTab === 'workspace' && !isEditorAreaVisible;
  const isCollapsedRef = useRef(isWorkspaceEditorAreaCollapsed);
  isCollapsedRef.current = isWorkspaceEditorAreaCollapsed;
  const wasEditorAreaCollapsedRef = useRef(isWorkspaceEditorAreaCollapsed);

  const applyDefaultSizes = useCallback(
    (api: DockviewApi, onDone?: () => void) => {
      try {
        const currentArrangement = getLayoutArrangement();

        const leftGroup = getLeftGroup(api);
        if (
          leftGroup?.api.isVisible &&
          slotOfZone(currentArrangement, 'dock') !== 'center' &&
          slotOfZone(currentArrangement, 'dock') !== 'bottom'
        ) {
          leftGroup.api.setSize({ width: defaultDockWidth(api.width) });
        }

        const rightGroup = getRightGroup(api);
        if (
          rightGroup?.api.isVisible &&
          slotOfZone(currentArrangement, 'session') !== 'center' &&
          slotOfZone(currentArrangement, 'session') !== 'bottom'
        ) {
          rightGroup.api.setSize({ width: defaultSessionWidth(api.width) });
        }

        const bottomGroup = getBottomGroup(api);
        if (
          bottomGroup?.api.isVisible &&
          slotOfZone(currentArrangement, 'terminal') === 'bottom'
        ) {
          bottomGroup.api.setSize({ height: DEFAULT_TERMINAL_PANEL_HEIGHT });
        }
      } catch {
        // Ignore sizing errors during layout transitions.
      }

      onDone?.();
    },
    []
  );

  const buildArrangeOptions = useCallback((): ArrangeLayoutOptions => {
    const layoutState = useLayoutStore.getState();
    const gridWidth = apiRef.current?.width ?? 0;
    return {
      fallbackSizes: {
        dock: { width: defaultDockWidth(gridWidth) },
        session: { width: defaultSessionWidth(gridWidth) },
        terminal: { height: DEFAULT_TERMINAL_PANEL_HEIGHT },
      },
      sessionVisible: layoutState.isRightPanelVisible,
    };
  }, []);

  // Refs so applyArrangement can reach logic declared later in this
  // component (tab visibility enforcement, full rebuild fallback) without
  // dependency-order gymnastics.
  const enforceTabVisibilityRef = useRef<(api: DockviewApi) => void>(() => {});
  const rebuildDefaultLayoutRef = useRef<(api: DockviewApi) => void>(() => {});

  /** Re-shape the live dockview grid to match the configured arrangement. */
  const applyArrangement = useCallback(
    (api: DockviewApi, nextArrangement: LayoutArrangement) => {
      appliedArrangementRef.current = nextArrangement;
      isResettingRef.current = true;
      try {
        // Renamed group ids must be re-synced into dockview's registry or
        // fromJSON() on a populated instance throws while clearing.
        syncDockviewGroupRegistry(api);
        const next = arrangeSerializedLayout(
          api.toJSON(),
          nextArrangement,
          buildArrangeOptions()
        );
        api.fromJSON(next);
        normalizeGroupIds(api);
      } catch (error) {
        console.warn(
          'Failed to apply layout arrangement, rebuilding default.',
          error
        );
        // fromJSON can fail mid-clear and leave a partial grid — recover
        // with a clean rebuild instead of persisting the broken state.
        rebuildDefaultLayoutRef.current(api);
        isResettingRef.current = false;
        return;
      } finally {
        isResettingRef.current = false;
      }

      // fromJSON restores serialized visibility; re-assert what the active
      // tab expects (e.g. dock/terminal stay hidden on the kanban board).
      enforceTabVisibilityRef.current(api);

      try {
        setSerializedLayout(api.toJSON());
      } catch {
        // Ignore serialization failures during arrangement transitions.
      }
    },
    [buildArrangeOptions, setSerializedLayout]
  );

  const rebuildDefaultLayout = useCallback(
    (api: DockviewApi, persistAfterBuild: boolean = true) => {
      isResettingRef.current = true;

      if (layoutChangeTimerRef.current) {
        clearTimeout(layoutChangeTimerRef.current);
        layoutChangeTimerRef.current = null;
      }

      for (const group of [...api.groups]) {
        try {
          api.removeGroup(group);
        } catch {
          // Ignore stale groups during full rebuild.
        }
      }

      for (const panel of [...api.panels]) {
        try {
          api.removePanel(panel);
        } catch {
          // Ignore orphan panels after group cleanup.
        }
      }

      buildDefaultLayout(api);

      const currentArrangement = getLayoutArrangement();
      appliedArrangementRef.current = currentArrangement;
      if (!isDefaultArrangement(currentArrangement)) {
        try {
          api.fromJSON(
            arrangeSerializedLayout(
              api.toJSON(),
              currentArrangement,
              buildArrangeOptions()
            )
          );
          normalizeGroupIds(api);
        } catch {
          // Keep the default arrangement if the transform fails.
        }
      }

      isResettingRef.current = false;
      requestAnimationFrame(() =>
        applyDefaultSizes(api, () => {
          if (!persistAfterBuild) return;

          try {
            setSerializedLayout(api.toJSON());
          } catch {
            // Ignore serialization failures during rebuild.
          }
        })
      );
    },
    [applyDefaultSizes, buildArrangeOptions, setSerializedLayout]
  );
  rebuildDefaultLayoutRef.current = rebuildDefaultLayout;

  // Terminal visibility captured when a surface that hides the bottom dock
  // is active, so returning to the workspace restores the user's previous choice.
  const terminalVisibleBeforeKanbanRef = useRef<boolean | null>(null);

  const hideWorkspaceZonesForKanban = useCallback((api: DockviewApi) => {
    const bottomGroup = getBottomGroup(api);
    const shelfId = terminalShelfGroupId();
    const shelf = shelfId ? api.getGroup(shelfId) : undefined;
    const terminalGroup = bottomGroup ?? shelf;
    if (terminalGroup) {
      if (terminalVisibleBeforeKanbanRef.current === null) {
        terminalVisibleBeforeKanbanRef.current = terminalGroup.api.isVisible;
      }
      terminalGroup.api.setVisible(false);
    }
    setLeftDockVisible(api, getLayoutArrangement(), false);
  }, []);

  const ensureWorkspacePanelsVisible = useCallback(
    (api: DockviewApi) => {
      if (effectiveActiveTab !== 'workspace' && !effectiveWorkspaceId) return;

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
          constraints: { minimumWidth: LAYOUT.LEFT_PANEL_MIN_WIDTH },
          initialWidth: defaultDockWidth(api.width),
        });
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
        const welcomeGroup = recreateWelcomeEditorGroup(api);
        if (welcomeGroup) {
          setColumnVisible(api, getLayoutArrangement(), welcomeGroup, true);
          restoreFlexibleEditorColumn(
            api,
            getLayoutArrangement(),
            useLayoutStore.getState().rightPanelWidth
          );
        }
      }

      const restoredFromKanban = terminalVisibleBeforeKanbanRef.current;
      terminalVisibleBeforeKanbanRef.current = null;
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
    },
    [effectiveActiveTab, effectiveWorkspaceId]
  );

  const ensureSessionPanel = useCallback((api: DockviewApi) => {
    let rightGroup = getRightGroup(api);
    if (!rightGroup) {
      const editorGroup =
        getEditorGroups(api)[0] ?? recreateWelcomeEditorGroup(api);
      const referencePanel = editorGroup?.panels[0];
      if (!referencePanel) return undefined;

      rightGroup = api.addGroup({
        id: GROUP_IDS.RIGHT,
        referencePanel,
        direction: 'right',
        constraints: { minimumWidth: MIN_RIGHT_PANEL_WIDTH },
        initialWidth: defaultSessionWidth(api.width),
      });
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
  }, []);

  enforceTabVisibilityRef.current = (api: DockviewApi) => {
    if (hidesBottomDock) {
      hideWorkspaceZonesForKanban(api);
      return;
    }

    if (isWorkspaceEditorAreaCollapsed) return;

    try {
      ensureWorkspacePanelsVisible(api);
    } catch {
      // Ignore restore failures; the workspace-tab effect retries.
    }
  };

  const lastDropTargetZoneRef = useRef<'editor' | 'session' | null>(null);

  const registerDndGuard = useCallback((api: DockviewApi) => {
    return api.onWillShowOverlay((event) => {
      const ev: DockviewWillShowOverlayLocationEvent = event;
      if (ev.kind === 'edge') {
        event.preventDefault();
        return;
      }

      const targetGroup = ev.group;
      const panelData = ev.getData?.();
      const draggedPanelId = panelData?.panelId ?? ev.panel?.id;

      if (!targetGroup || !draggedPanelId) {
        return;
      }

      const sourceGroup = panelData?.groupId
        ? api.getGroup(panelData.groupId)
        : undefined;
      const isSourceLeftPanel = sourceGroup
        ? isLeftGroup(sourceGroup)
        : LEFT_PANEL_IDS.has(draggedPanelId);
      const isSourceBottomPanel = sourceGroup
        ? isBottomGroup(sourceGroup)
        : BOTTOM_PANEL_IDS.has(draggedPanelId);
      const isTargetLeftGroup = isLeftGroup(targetGroup);
      const isTargetBottomGroup = isBottomGroup(targetGroup);
      const isTargetEditorGroup = isEditorGroup(targetGroup);
      const isTargetSessionGroup = isSessionGroup(targetGroup);

      if (isSourceBottomPanel || isTargetBottomGroup) {
        event.preventDefault();
        return;
      }

      if (isTargetLeftGroup && !isSourceLeftPanel) {
        event.preventDefault();
        return;
      }

      if (isSourceLeftPanel && !isTargetLeftGroup) {
        event.preventDefault();
        return;
      }

      if (
        isTargetEditorGroup &&
        getEditorGroups(api).length >= MAX_EDITOR_GROUPS &&
        ev.position !== 'center' &&
        ev.kind === 'content'
      ) {
        event.preventDefault();
        return;
      }

      if (
        isTargetSessionGroup &&
        listSessionGroups(api.groups).length >= MAX_EDITOR_GROUPS &&
        ev.position !== 'center' &&
        ev.kind === 'content'
      ) {
        event.preventDefault();
        return;
      }

      lastDropTargetZoneRef.current = isTargetSessionGroup
        ? 'session'
        : isTargetEditorGroup
          ? 'editor'
          : null;
    });
  }, []);

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      setDockviewApi(api);

      const layout = serializedLayoutRef.current;
      const currentArrangement = getLayoutArrangement();
      appliedArrangementRef.current = currentArrangement;
      if (layout) {
        try {
          // A layout already matching the arrangement restores VERBATIM — the
          // transform re-synthesizes the grid and loses user-dragged widths
          // (e.g. with the editor area collapsed). It only runs when needed:
          // pre-session-group migration or an arrangement change since the
          // layout was persisted.
          api.fromJSON(
            serializedLayoutMatchesArrangement(layout, currentArrangement)
              ? layout
              : arrangeSerializedLayout(
                  layout,
                  currentArrangement,
                  buildArrangeOptions()
                )
          );
          normalizeGroupIds(api);
        } catch (error) {
          console.warn(
            'Failed to restore dockview layout, rebuilding default.',
            error
          );
          rebuildDefaultLayout(api, false);
        }
      } else {
        buildDefaultLayout(api);
        if (!isDefaultArrangement(currentArrangement)) {
          applyArrangement(api, currentArrangement);
        }
        requestAnimationFrame(() => applyDefaultSizes(api));
      }

      enforceTabVisibilityRef.current(api);
      setReadyDockviewApi(api);

      let resizeFrame: number | null = null;
      const dockviewResizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;

        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) return;

        if (resizeFrame !== null) {
          cancelAnimationFrame(resizeFrame);
        }
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = null;
          if (apiRef.current !== api) return;

          const arrangement = getLayoutArrangement();
          const dockGroups =
            slotOfZone(arrangement, 'dock') !== 'center' &&
            slotOfZone(arrangement, 'dock') !== 'bottom'
              ? listLeftDockGroups(api.groups)
              : [];
          const sideGroups = [
            ...(dockGroups.length > 0
              ? dockGroups
              : slotOfZone(arrangement, 'dock') !== 'center' &&
                  slotOfZone(arrangement, 'dock') !== 'bottom'
                ? [getLeftGroup(api)]
                : []),
            slotOfZone(arrangement, 'session') !== 'center' &&
            slotOfZone(arrangement, 'session') !== 'bottom'
              ? getRightGroup(api)
              : null,
          ].filter((group): group is DockviewGroup => Boolean(group));

          layoutDockviewPreservingGroupWidths(api, sideGroups, width, height);
        });
      });
      if (dockviewRootRef.current) {
        dockviewResizeObserver.observe(dockviewRootRef.current);
      }

      const pointerTabDndDisposable = dockviewRootRef.current
        ? installDockviewPointerTabDnd(dockviewRootRef.current)
        : null;
      const dndGuardDisposable = registerDndGuard(api);
      const removePanelDisposable = api.onDidRemovePanel((panel) => {
        if (isResettingRef.current) return;

        if (isSessionPanelId(panel.id)) {
          const remainingSessionPanels = api.panels.some((item) =>
            isSessionPanelId(item.id)
          );
          const sessionGroupsHavePanels = listSessionGroups(api.groups).some(
            (group) => group.panels.length > 0
          );
          if (!remainingSessionPanels && !sessionGroupsHavePanels) {
            useLayoutStore.getState().setRightPanelVisible(false);
            setSessionDockVisible(api, getLayoutArrangement(), false);
            const hasVisibleEditorPanels = getEditorGroups(api).some(
              (group) => group.api.isVisible && group.panels.length > 0
            );
            if (!hasVisibleEditorPanels) {
              const welcomeGroup = recreateWelcomeEditorGroup(api);
              if (welcomeGroup) {
                setColumnVisible(
                  api,
                  getLayoutArrangement(),
                  welcomeGroup,
                  true
                );
                restoreFlexibleEditorColumn(
                  api,
                  getLayoutArrangement(),
                  useLayoutStore.getState().rightPanelWidth
                );
                api.getPanel(PANEL_IDS.WELCOME)?.api.setActive();
              }
            }
            normalizeGroupIds(api);
            return;
          }
        }

        normalizeGroupIds(api);
        const editorGroups = getEditorGroups(api);
        const hasEditorPanels = editorGroups.some(
          (group) => group.panels.length > 0
        );
        const hasVisibleSessionPanels = listSessionGroups(api.groups).some(
          (group) => group.api.isVisible && group.panels.length > 0
        );

        if (
          shouldDismissEditorColumnAfterPanelRemoval(panel, editorGroups) ||
          (!hasEditorPanels && !LEFT_PANEL_IDS.has(panel.id))
        ) {
          if (hasVisibleSessionPanels) {
            dismissEditorColumnAfterLastTab(api);
          } else {
            const welcomeGroup = recreateWelcomeEditorGroup(api);
            if (welcomeGroup) {
              setColumnVisible(api, getLayoutArrangement(), welcomeGroup, true);
              restoreFlexibleEditorColumn(
                api,
                getLayoutArrangement(),
                useLayoutStore.getState().rightPanelWidth
              );
              api.getPanel(PANEL_IDS.WELCOME)?.api.setActive();
            }
          }
        }
      });

      const normalizeGroupsDisposable = api.onDidAddGroup((group) => {
        if (!isResettingRef.current) {
          const isUnassignedGroupId =
            group.id !== GROUP_IDS.LEFT &&
            !group.id.startsWith(EDITOR_GROUP_PREFIX) &&
            group.id !== GROUP_IDS.RIGHT &&
            !group.id.startsWith(RIGHT_GROUP_PREFIX) &&
            group.id !== GROUP_IDS.BOTTOM;
          if (
            lastDropTargetZoneRef.current === 'session' &&
            isUnassignedGroupId
          ) {
            (group as { id: string }).id = getNextRightGroupId(api);
            group.element?.setAttribute('data-session-dock', 'true');
          } else if (
            lastDropTargetZoneRef.current === 'editor' &&
            isUnassignedGroupId
          ) {
            (group as { id: string }).id = getNextEditorGroupId(api);
            group.element?.removeAttribute('data-session-dock');
          }
          lastDropTargetZoneRef.current = null;
          normalizeGroupIds(api);
        }
      });

      const movePanelDisposable = api.onDidMovePanel(({ panel, from }) => {
        if (isResettingRef.current) return;

        if (panel.group === from) {
          if (
            lastDropTargetZoneRef.current === 'editor' &&
            isSessionGroup(from)
          ) {
            from.element?.removeAttribute('data-session-dock');
            (from as { id: string }).id = getNextEditorGroupId(api);
          } else if (
            lastDropTargetZoneRef.current === 'session' &&
            isEditorGroup(from)
          ) {
            from.element?.setAttribute('data-session-dock', 'true');
            (from as { id: string }).id = getNextRightGroupId(api);
          }
        }
        lastDropTargetZoneRef.current = null;

        if (getEditorGroups(api).length === 0 && !isCollapsedRef.current) {
          recreateWelcomeEditorGroup(api);
        }

        if (listSessionGroups(api.groups).length === 0) {
          const editorGroups = getEditorGroups(api);
          const referenceGroup =
            editorGroups[editorGroups.length - 1] ?? getLeftGroup(api);
          const referencePanel = referenceGroup?.panels[0];
          if (referencePanel) {
            const rightGroup = api.addGroup({
              id: GROUP_IDS.RIGHT,
              referencePanel,
              direction: 'right',
              constraints: { minimumWidth: MIN_RIGHT_PANEL_WIDTH },
              initialWidth:
                useLayoutStore.getState().rightPanelWidth ||
                defaultSessionWidth(api.width),
            });
            rightGroup.element?.setAttribute('data-session-dock', 'true');
            if (!useLayoutStore.getState().isRightPanelVisible) {
              rightGroup.api.setVisible(false);
            }
          }
        }

        normalizeGroupIds(api);
      });

      const removeGroupDisposable = api.onDidRemoveGroup(() => {
        if (!isResettingRef.current) {
          normalizeGroupIds(api);
        }
      });
      const columnWidthRebalance = installEditorColumnWidthRebalance(api, {
        shouldRebalance: () => !isResettingRef.current,
      });

      const layoutDisposable = api.onDidLayoutChange(() => {
        if (isResettingRef.current) return;

        if (layoutChangeTimerRef.current) {
          clearTimeout(layoutChangeTimerRef.current);
        }

        layoutChangeTimerRef.current = setTimeout(() => {
          layoutChangeTimerRef.current = null;
          if (isResettingRef.current) return;

          normalizeGroupIds(api);

          // Self-heal: if some code path re-created a zone group in the
          // wrong column, snap the grid back to the configured arrangement.
          // Cooldown guards against churn if a mismatch were ever persistent.
          const currentArrangement = getLayoutArrangement();
          if (
            !zoneOrderMatchesArrangement(api, currentArrangement) &&
            Date.now() - lastSelfHealAtRef.current > 5000
          ) {
            lastSelfHealAtRef.current = Date.now();
            applyArrangement(api, currentArrangement);
            return;
          }

          const persistLayout = () => {
            try {
              setSerializedLayout(api.toJSON());
            } catch {
              // Ignore serialization failures during transient layout states.
            }

            // Keep the stored session width in sync so default rebuilds and
            // cross-slot moves reuse the user's last column width. Center and
            // bottom slots are skipped: there the group width is the flexible
            // remainder / plain column width, not a meaningful column memory.
            // A crushed editor column is also skipped: the session has absorbed
            // leftover space, and that expanded width is not user intent.
            try {
              const rightGroup = getRightGroup(api);
              const sessionSlot = slotOfZone(getLayoutArrangement(), 'session');
              if (
                rightGroup?.api.isVisible &&
                sessionSlot !== 'center' &&
                sessionSlot !== 'bottom' &&
                rightGroup.api.width > 0 &&
                shouldPersistSessionColumnWidth(api) &&
                rightGroup.api.width !==
                  useLayoutStore.getState().rightPanelWidth
              ) {
                setRightPanelWidth(rightGroup.api.width);
              }
            } catch {
              // Ignore width sync failures during transient layout states.
            }
          };

          if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(persistLayout, {
              timeout: LAYOUT.IDLE_PERSIST_TIMEOUT_MS,
            });
          } else {
            persistLayout();
          }
        }, LAYOUT.LAYOUT_CHANGE_DEBOUNCE_MS);
      });

      return () => {
        dockviewResizeObserver.disconnect();
        if (resizeFrame !== null) {
          cancelAnimationFrame(resizeFrame);
        }
        pointerTabDndDisposable?.dispose();
        dndGuardDisposable.dispose();
        removePanelDisposable.dispose();
        normalizeGroupsDisposable.dispose();
        movePanelDisposable.dispose();
        removeGroupDisposable.dispose();
        columnWidthRebalance.dispose();
        layoutDisposable.dispose();

        if (layoutChangeTimerRef.current) {
          clearTimeout(layoutChangeTimerRef.current);
          layoutChangeTimerRef.current = null;
        }
      };
    },
    [
      applyArrangement,
      applyDefaultSizes,
      buildArrangeOptions,
      rebuildDefaultLayout,
      registerDndGuard,
      setDockviewApi,
      setRightPanelWidth,
      setSerializedLayout,
    ]
  );

  useLayoutEffect(() => {
    if (!isLayoutScopeReady) {
      apiRef.current = null;
      setReadyDockviewApi(null);
      setDockviewApi(null);
    }
  }, [isLayoutScopeReady, setDockviewApi]);

  useEffect(() => {
    return () => {
      apiRef.current = null;
      setReadyDockviewApi(null);
      setDockviewApi(null);
    };
  }, [setDockviewApi]);

  useEffect(() => {
    const previous = prevSerializedLayoutRef.current;
    prevSerializedLayoutRef.current = {
      projectKey: currentLayoutProject,
      serializedLayout,
    };

    if (
      previous.projectKey === currentLayoutProject &&
      previous.serializedLayout !== null &&
      serializedLayout === null
    ) {
      const api = apiRef.current;
      if (!api) return;
      rebuildDefaultLayout(api);
    }
  }, [currentLayoutProject, rebuildDefaultLayout, serializedLayout]);

  useLayoutEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (effectiveActiveTab !== 'workspace') return;
    if (isWorkspaceEditorAreaCollapsed) return;

    try {
      ensureWorkspacePanelsVisible(api);
    } catch (error) {
      console.warn(
        'Failed to restore workspace panels, rebuilding layout.',
        error
      );
      rebuildDefaultLayout(api);
    }
  }, [
    effectiveActiveTab,
    effectiveWorkspaceId,
    ensureWorkspacePanelsVisible,
    isWorkspaceEditorAreaCollapsed,
    rebuildDefaultLayout,
  ]);

  // Surfaces that declare hidesBottomDock replace the dock/workspace/terminal
  // zones; only the session zone stays interactive next to them.
  useLayoutEffect(() => {
    const api = apiRef.current;
    if (!api || !hidesBottomDock) return;

    hideWorkspaceZonesForKanban(api);
  }, [hidesBottomDock, hideWorkspaceZonesForKanban]);

  // Re-shape the grid when the arrangement preference changes (e.g. from the
  // settings window, synced through the storage event).
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (
      appliedArrangementRef.current &&
      arrangementsEqual(appliedArrangementRef.current, arrangement)
    ) {
      return;
    }

    applyArrangement(api, arrangement);
  }, [arrangement, applyArrangement]);

  const workspaceStageStyle = useWorkspaceStageStyle();
  const collaborationEnabled = Boolean(config?.multi_agent_enabled);
  const isWorkspaceCanvasMode =
    hasProject &&
    effectiveActiveTab === 'workspace' &&
    workspaceStageStyle === 'canvas';

  // Session zone visibility follows the store flag and content availability.
  // Layout-phase so the native browser host measures the destination split
  // before the HWND is allowed to paint.
  useLayoutEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    const shouldShow =
      isRightPanelVisible && !!rightPanelContent && !isWorkspaceCanvasMode;
    const rightGroup = shouldShow
      ? (ensureSessionPanel(api) ?? getRightGroup(api))
      : getRightGroup(api);
    if (!rightGroup) return;

    setSessionDockVisible(api, getLayoutArrangement(), shouldShow);
  }, [
    ensureSessionPanel,
    isRightPanelVisible,
    isWorkspaceCanvasMode,
    rightPanelContent,
  ]);

  // Collapsed editor area: hide the editor column and terminal strip. The
  // file-tree dock stays; the session column takes the leftover width.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || effectiveActiveTab !== 'workspace') return;

    if (isWorkspaceEditorAreaCollapsed) {
      const updates = groupsHiddenWhenEditorAreaCollapsed({
        dock: getLeftGroup(api),
        workspace: getEditorGroups(api),
        terminal: getBottomGroup(api),
        session: getRightGroup(api),
      }).map((group) => ({ group, visible: false }));
      setColumnsVisible(api, getLayoutArrangement(), updates);
      wasEditorAreaCollapsedRef.current = true;
      return;
    }

    const recoveringFromToolbarCollapse = wasEditorAreaCollapsedRef.current;
    wasEditorAreaCollapsedRef.current = false;

    const editorUpdates = getEditorGroups(api).flatMap((group) => {
      if (group.api.isVisible) return [];
      if (isTerminalShelfGroup(group.id) && !isTerminalShelfOpen()) {
        return [];
      }
      const hasContent = group.panels.some(
        (panel) => !isPlaceholderPanelId(panel.id)
      );
      if (recoveringFromToolbarCollapse || hasContent) {
        return [{ group, visible: true }];
      }
      return [];
    });
    if (editorUpdates.length > 0) {
      setColumnsVisible(api, getLayoutArrangement(), editorUpdates);
    }
    try {
      ensureWorkspacePanelsVisible(api);
    } catch {
      // Ignore restore failures; the workspace-tab effect retries.
    }
  }, [
    effectiveActiveTab,
    ensureWorkspacePanelsVisible,
    isWorkspaceEditorAreaCollapsed,
  ]);

  const sessionPlacement = useMemo<SessionPanelPlacement>(
    () => ({
      host: rightPanelContent ? sessionContentHost : null,
      placement: effectiveActiveTab === 'kanban' ? 'kanban' : 'workspace',
    }),
    [effectiveActiveTab, rightPanelContent, sessionContentHost]
  );
  useWorkspaceShortcuts();

  const { setChromeOccluded } = useWorkspaceOverlay();
  useLayoutEffect(() => {
    if (chromeHidesNativeSurface(effectiveActiveTab)) {
      setChromeOccluded(true);
      return;
    }
    const api = apiRef.current;
    if (api && !isWorkspaceEditorAreaCollapsed) {
      try {
        ensureWorkspacePanelsVisible(api);
      } catch {
        // HostBrowserPanel still waits for a stable destination slot.
      }
      const shouldShow =
        isRightPanelVisible && !!rightPanelContent && !isWorkspaceCanvasMode;
      const rightGroup = shouldShow
        ? (ensureSessionPanel(api) ?? getRightGroup(api))
        : getRightGroup(api);
      if (rightGroup) {
        setSessionDockVisible(api, getLayoutArrangement(), shouldShow);
      }
    }
    setChromeOccluded(false);
  }, [
    effectiveActiveTab,
    ensureSessionPanel,
    ensureWorkspacePanelsVisible,
    isRightPanelVisible,
    isWorkspaceCanvasMode,
    isWorkspaceEditorAreaCollapsed,
    rightPanelContent,
    setChromeOccluded,
  ]);
  useLayoutEffect(() => {
    return () => setChromeOccluded(false);
  }, [setChromeOccluded]);

  const [canvasStageInsets, setCanvasStageInsets] = useState<CanvasStageInsets>(
    { left: 0, right: 0 }
  );

  useLayoutEffect(() => {
    if (!isWorkspaceCanvasMode) return;
    const measureInsets = () => {
      const next = measureCanvasStageInsets(
        apiRef.current ?? readyDockviewApi,
        dockviewRootRef.current,
        arrangement
      );
      setCanvasStageInsets((prev) =>
        prev.left === next.left && prev.right === next.right ? prev : next
      );
    };

    const api = apiRef.current ?? readyDockviewApi;
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => measureInsets())
        : null;
    const groupDisposables: Array<{ dispose: () => void }> = [];
    const clearGroupObservers = () => {
      while (groupDisposables.length > 0) {
        groupDisposables.pop()?.dispose();
      }
      resizeObserver?.disconnect();
    };

    const syncGroupObservers = () => {
      clearGroupObservers();
      const host = dockviewRootRef.current;
      if (resizeObserver && host) {
        resizeObserver.observe(host);
      }
      const currentApi = apiRef.current ?? readyDockviewApi;
      if (!currentApi) return;
      for (const group of currentApi.groups) {
        if (group.api?.onDidDimensionsChange) {
          groupDisposables.push(
            group.api.onDidDimensionsChange(() => measureInsets())
          );
        }
        if (group.api?.onDidVisibilityChange) {
          groupDisposables.push(
            group.api.onDidVisibilityChange(() => measureInsets())
          );
        }
        if (resizeObserver) {
          const el = getGroupElement(group);
          if (el) {
            resizeObserver.observe(el);
            if (el.parentElement) {
              resizeObserver.observe(el.parentElement);
            }
          }
        }
      }
    };

    syncGroupObservers();
    measureInsets();

    const handleStructureChange = () => {
      syncGroupObservers();
      measureInsets();
    };
    const apiDisposables = [
      api?.onDidLayoutChange(handleStructureChange),
      api?.onDidAddGroup(handleStructureChange),
      api?.onDidRemoveGroup(handleStructureChange),
      api?.onDidMovePanel(handleStructureChange),
    ];

    let removeSashMoveListeners: (() => void) | null = null;
    const handlePointerDownCapture = (event: PointerEvent) => {
      const target = event.target;
      const host = dockviewRootRef.current;
      if (!(target instanceof Element) || !host || !host.contains(target)) {
        return;
      }
      if (!target.closest('.dv-sash')) return;
      removeSashMoveListeners?.();
      const onMove = () => measureInsets();
      const onEnd = () => {
        measureInsets();
        removeSashMoveListeners?.();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onEnd);
      document.addEventListener('pointercancel', onEnd);
      removeSashMoveListeners = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onEnd);
        document.removeEventListener('pointercancel', onEnd);
        removeSashMoveListeners = null;
      };
    };
    document.addEventListener('pointerdown', handlePointerDownCapture, true);

    return () => {
      document.removeEventListener(
        'pointerdown',
        handlePointerDownCapture,
        true
      );
      removeSashMoveListeners?.();
      for (const disp of apiDisposables) {
        disp?.dispose();
      }
      clearGroupObservers();
    };
  }, [
    arrangement,
    isDockviewMounted,
    isWorkspaceCanvasMode,
    readyDockviewApi,
    serializedLayout,
  ]);

  const forwardCanvasBoundarySashPointerDown = useCallback(
    (side: 'left' | 'right', event: React.PointerEvent<HTMLDivElement>) => {
      const host = dockviewRootRef.current;
      if (!host || event.button !== 0) return;
      const bestSash = findCanvasBoundarySash(host, canvasStageInsets, side);
      if (!bestSash) return;
      event.preventDefault();
      event.stopPropagation();
      bestSash.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          button: event.button,
          buttons: event.buttons || 1,
        })
      );
    },
    [canvasStageInsets]
  );

  const showZeroProjectStage =
    !hasProject && !ActiveSdkTabComponent && !activePluginTab;

  const layoutBody = (
    <div className="flex min-h-0 flex-1">
      {hasProject &&
      (effectiveActiveTab === 'workspace' || effectiveActiveTab === 'kanban') ? (
        <WorkspaceActivityRail
          mode={effectiveActiveTab === 'kanban' ? 'kanban' : 'workspace'}
          isEditorAreaVisible={isEditorAreaVisible}
          onToggleEditorArea={toggleEditorArea}
        />
      ) : null}

      <RightPanelSlotContext.Provider value={sessionPlacement}>
        <div
          className="workspace-stage-host relative flex flex-1 min-w-0 flex-col"
          data-canvas-stage-active={isWorkspaceCanvasMode ? 'true' : undefined}
          ref={dockviewRootRef}
        >
          <MobileDeviceConnectBanner />
          {showZeroProjectStage ? <WorkspaceZeroProjectStage /> : null}

          {hasProject && isDockviewMounted ? (
            <div
              className="min-h-0 flex-1"
              style={
                effectiveActiveTab === 'workspace'
                  ? undefined
                  : { display: 'none' }
              }
              aria-hidden={effectiveActiveTab !== 'workspace'}
            >
              <DockviewReact
                components={panelComponents}
                defaultTabComponent={WorkspaceDockviewTab}
                leftHeaderActionsComponent={WorkspaceTabAddMenu}
                onReady={handleReady}
                className="dockview-theme-light dockview-theme-ayu"
                disableAutoResizing={true}
                disableFloatingGroups={true}
                dndEdges={false}
              />
            </div>
          ) : null}

          {isWorkspaceCanvasMode ? (
            <div
              className="kanban-overlay absolute top-0 bottom-0 z-10 min-w-0"
              style={{
                left: canvasStageInsets.left,
                right: canvasStageInsets.right,
                width: `calc(100% - ${canvasStageInsets.left + canvasStageInsets.right}px)`,
              }}
              data-testid="workspace-canvas-stage"
            >
              {canvasStageInsets.left > 0 ? (
                <div
                  aria-hidden="true"
                  data-testid="workspace-canvas-sash-proxy-left"
                  className="absolute top-0 bottom-0 -left-1 z-30 w-2 cursor-ew-resize"
                  onPointerDown={(event) =>
                    forwardCanvasBoundarySashPointerDown('left', event)
                  }
                />
              ) : null}
              {canvasStageInsets.right > 0 ? (
                <div
                  aria-hidden="true"
                  data-testid="workspace-canvas-sash-proxy-right"
                  className="absolute top-0 bottom-0 -right-1 z-30 w-2 cursor-ew-resize"
                  onPointerDown={(event) =>
                    forwardCanvasBoundarySashPointerDown('right', event)
                  }
                />
              ) : null}
              <Suspense fallback={null}>
                <LazyWorkspaceCanvasStage
                  presentation="canvas"
                  workspaceStage
                  zoneOrder={['list', 'monitor', 'session']}
                />
              </Suspense>
            </div>
          ) : null}

          {hasProject ? (
            <KeepAliveSurface
              active={effectiveActiveTab === 'kanban'}
              evictAfterMs={KANBAN_INACTIVE_EVICT_MS}
              className="kanban-overlay absolute inset-0 z-10"
            >
              <Suspense
                fallback={
                  <div className="kanban-loading-state flex h-full w-full items-center justify-center p-6 text-sm">
                    <div className="workspace-loading-panel flex items-center gap-3 px-4 py-3">
                      <div className="h-4 w-4 animate-spin rounded-full border border-primary border-t-transparent" />
                      <span>Loading Kanban...</span>
                    </div>
                  </div>
                }
              >
                <LazyKanbanBoard />
              </Suspense>
            </KeepAliveSurface>
          ) : null}

          {ActiveSdkTabComponent ? (
            <div className="kanban-overlay absolute inset-0 z-10">
              <ActiveSdkTabComponent
                workspaceId={surfaceWorkspaceId}
                projectId={projectId ?? null}
              />
            </div>
          ) : null}

          {activePluginTab ? (
            <div className="kanban-overlay absolute inset-0 z-10">
              <PluginRemoteView
                item={activePluginTab}
                slot="app.tab"
                enabled
                workspaceId={surfaceWorkspaceId}
                projectId={projectId ?? null}
              />
            </div>
          ) : null}
        </div>
      </RightPanelSlotContext.Provider>
    </div>
  );

  return (
    <div className="workspace-shell relative flex h-full w-full flex-col">
      <SearchPalette />
      <PluginOverlays
        context={{
          projectId: projectId ?? null,
          workspaceId: surfaceWorkspaceId,
          activeTab: effectiveActiveTab,
        }}
      />
      {toolbarContent && (
        <div className="workspace-divider-bottom z-10 shrink-0">
          {toolbarContent}
        </div>
      )}

      <ProjectLayoutScope>
        {collaborationEnabled ? (
          <CollaborationSpaceProvider workspaceId={surfaceWorkspaceId}>
            {layoutBody}
          </CollaborationSpaceProvider>
        ) : (
          layoutBody
        )}
      </ProjectLayoutScope>

      {hasProject && rightPanelContent && sessionContentHost
        ? createPortal(rightPanelContent, sessionContentHost)
        : null}

      <StatusBar />
    </div>
  );
}
