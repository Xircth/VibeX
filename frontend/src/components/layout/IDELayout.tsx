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
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from 'dockview-react';
import {
  WorkspaceDockviewTab,
  panelComponents,
} from '@/components/layout/panels/PanelRegistry';
import { WorkspaceActivityRail } from '@/components/layout/WorkspaceActivityRail';
import { WorkspaceTabAddMenu } from '@/components/layout/panels/WorkspaceTabAddMenu';
import {
  useOptionalPanelActionsContext,
  usePanelActionsContext,
} from '@/contexts/PanelActionsContext';
import { useViews } from '@dimoai/plugin-sdk';
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
import { GithubStarPrompt } from '@/components/layout/GithubStarPrompt';
import { MobileDeviceConnectBanner } from '@/components/layout/MobileDeviceConnectBanner';
import { StatusBar } from '@/components/layout/StatusBar';
import { WorkspaceZeroProjectStage } from '@/components/layout/WorkspaceZeroProjectStage';
import { ProjectLayoutScope, useProject } from '@/contexts/ProjectContext';
import { useLayoutStore } from '@/stores/useLayoutStore';
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
import { syncDockviewGroupRegistry } from '@/utils/dockviewGroupRole';
import {
  setLeftDockVisible,
  setSessionDockVisible,
  setColumnsVisible,
} from '@/utils/dockviewEditorGroup';
import { groupsHiddenWhenEditorAreaCollapsed } from '@/utils/lastPreviewTabLayout';
import { DEFAULT_TERMINAL_PANEL_HEIGHT } from '@/lib/terminalPreferences';
import {
  isTerminalShelfGroup,
  isTerminalShelfOpen,
  terminalShelfGroupId,
} from '@/lib/terminalShelf';
import {
  arrangementsEqual,
  getLayoutArrangement,
  isDefaultArrangement,
  slotOfZone,
  useLayoutArrangement,
  type LayoutArrangement,
} from '@/lib/layoutArrangement';
import {
  arrangeSerializedLayout,
  serializedLayoutMatchesArrangement,
  type ArrangeLayoutOptions,
} from '@/utils/dockviewLayoutTransform';
import { SearchPalette } from '@/components/search/SearchPalette';
import { useWorkspaceShortcuts } from '@/hooks/useWorkspaceShortcuts';
import {
  isPlaceholderPanelId,
  listSessionGroups,
} from '@/utils/dockviewGroupPolicy';
import '@/styles/dockview-ayu.css';
import { useWorkspaceStageStyle } from '@/lib/workspaceStageStyle';
import { useCanvasToTabsHandoff } from '@/components/layout/useCanvasToTabsHandoff';
import { useDockviewPanelActionsBinding } from '@/hooks/useDockviewPanelActionsBinding';
import { OptionalCollaborationSpaceProvider } from '@/features/collaboration/space/SpaceContext';
import { useWorkspaceStageInsets } from '@/components/layout/useWorkspaceStageInsets';
import { registerWorkspaceStageCreationHost } from '@/components/layout/workspaceStageCreationHost';
import {
  getLiveDockviewApi,
  isDockviewApiDisposed,
} from '@/utils/dockviewSessionPanel';
import {
  buildDefaultLayout,
  closeEmptyTabBarGroups,
  defaultDockWidth,
  defaultSessionWidth,
  ensureDockviewSessionPanel,
  getBottomGroup,
  getEditorGroups,
  getLeftGroup,
  getRightGroup,
  normalizeGroupIds,
  restoreWorkspaceDockviewPanels,
} from '@/components/layout/ideLayoutGroupNormalization';
import {
  attachDockviewWorkspaceListeners,
  forwardPointerDownToCanvasBoundarySash,
  registerDockviewOverlayDropGuard,
  routeWorkspaceTabBarDrop,
  type DropTargetZone,
} from '@/components/layout/ideLayoutDockviewListeners';

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
  const dockviewListenersCleanupRef = useRef<(() => void) | null>(null);
  const { activeWorktreeId } = useWorktree();
  const { projectId: contextProjectId } = useProject();
  const projectId = contextProjectId ?? routeProjectId;
  const projectKey = getProjectScopeKey(projectId);
  const rememberedWorkspaceId = useProjectViewStateStore(
    (state) => state.kanbanByProject[projectKey]?.lastActiveWorkspaceId ?? null
  );
  const { worktrees } = useProjectWorktrees(projectId);
  const serializedLayout = useLayoutStore((state) => state.serializedLayout);
  const setSerializedLayout = useLayoutStore(
    (state) => state.setSerializedLayout
  );
  const isRightPanelVisible = useLayoutStore(
    (state) => state.isRightPanelVisible
  );
  const setRightPanelWidth = useLayoutStore(
    (state) => state.setRightPanelWidth
  );
  const isEditorAreaVisible = useLayoutStore(
    (state) => state.isEditorAreaVisible
  );
  const toggleEditorArea = useLayoutStore((state) => state.toggleEditorArea);
  const activeTab = useLayoutStore((state) => state.activeTab);
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
  useDockviewPanelActionsBinding(
    isLayoutScopeReady ? readyDockviewApi : null,
    setDockviewApi
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
      requestAnimationFrame(() => {
        if (apiRef.current !== api || isDockviewApiDisposed(api)) return;
        applyDefaultSizes(api, () => {
          if (
            !persistAfterBuild ||
            apiRef.current !== api ||
            isDockviewApiDisposed(api)
          ) {
            return;
          }

          try {
            setSerializedLayout(api.toJSON());
          } catch {
            // Ignore serialization failures during rebuild.
          }
        });
      });
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
      restoreWorkspaceDockviewPanels(api, {
        effectiveActiveTab,
        effectiveWorkspaceId,
        terminalVisibleBeforeKanbanRef,
      });
    },
    [effectiveActiveTab, effectiveWorkspaceId]
  );

  const ensureSessionPanel = useCallback(
    (api: DockviewApi) => ensureDockviewSessionPanel(api),
    []
  );

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

  const lastDropTargetZoneRef = useRef<DropTargetZone>(null);

  const registerDndGuard = useCallback(
    (api: DockviewApi) =>
      registerDockviewOverlayDropGuard(api, lastDropTargetZoneRef),
    []
  );

  // Tab bar drop handler: accepts panel drag payloads from Zone A (file tree, git, sessions)
  const panelActions = useOptionalPanelActionsContext();
  const [isTabBarDragOver, setIsTabBarDragOver] = useState(false);

  const handleTabBarDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes('application/x-dimo-panel')) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setIsTabBarDragOver(true);
    },
    []
  );

  const handleTabBarDragLeave = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) {
        setIsTabBarDragOver(false);
      }
    },
    []
  );

  const handleTabBarDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes('application/x-dimo-panel')) {
        return;
      }
      event.preventDefault();
      setIsTabBarDragOver(false);

      const rawData = event.dataTransfer.getData('application/x-dimo-panel');
      if (!rawData || !panelActions) return;

      routeWorkspaceTabBarDrop(rawData, panelActions);
    },
    [panelActions]
  );

  const readLiveDockviewApi = useCallback((): DockviewApi | null => {
    const liveApi = getLiveDockviewApi(apiRef.current);
    if (!liveApi && apiRef.current !== null) {
      apiRef.current = null;
    }
    return liveApi;
  }, []);

  const setDockviewHostNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== null) return;
      dockviewListenersCleanupRef.current?.();
      dockviewListenersCleanupRef.current = null;
      apiRef.current = null;
      setDockviewApi(null);
      setReadyDockviewApi((prev) => (prev === null ? prev : null));
    },
    [setDockviewApi]
  );

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      dockviewListenersCleanupRef.current?.();
      dockviewListenersCleanupRef.current = null;

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
        requestAnimationFrame(() => {
          if (apiRef.current === api && !isDockviewApiDisposed(api)) {
            applyDefaultSizes(api);
          }
        });
      }

      enforceTabVisibilityRef.current(api);
      closeEmptyTabBarGroups(api);
      setReadyDockviewApi(api);

      dockviewListenersCleanupRef.current = attachDockviewWorkspaceListeners(
        api,
        {
          apiRef,
          dockviewRootEl: dockviewRootRef.current,
          isResettingRef,
          isCollapsedRef,
          lastDropTargetZoneRef,
          layoutChangeTimerRef,
          lastSelfHealAtRef,
          registerDndGuard,
          applyArrangement,
          setSerializedLayout,
          setRightPanelWidth,
        }
      );
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
      dockviewListenersCleanupRef.current?.();
      dockviewListenersCleanupRef.current = null;
      apiRef.current = null;
      setReadyDockviewApi(null);
      setDockviewApi(null);
    }
  }, [isLayoutScopeReady, setDockviewApi]);

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
      const api = readLiveDockviewApi();
      if (!api) return;
      rebuildDefaultLayout(api);
    }
  }, [
    currentLayoutProject,
    readLiveDockviewApi,
    rebuildDefaultLayout,
    serializedLayout,
  ]);

  useLayoutEffect(() => {
    const api = readLiveDockviewApi();
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
      if (!isDockviewApiDisposed(api)) {
        rebuildDefaultLayout(api);
      }
    }
  }, [
    effectiveActiveTab,
    effectiveWorkspaceId,
    ensureWorkspacePanelsVisible,
    isWorkspaceEditorAreaCollapsed,
    readLiveDockviewApi,
    rebuildDefaultLayout,
  ]);

  // Surfaces that declare hidesBottomDock replace the dock/workspace/terminal
  // zones; only the session zone stays interactive next to them.
  useLayoutEffect(() => {
    const api = readLiveDockviewApi();
    if (!api || !hidesBottomDock) return;

    try {
      hideWorkspaceZonesForKanban(api);
    } catch (error) {
      console.warn('Failed to hide workspace zones for surface.', error);
    }
  }, [hidesBottomDock, hideWorkspaceZonesForKanban, readLiveDockviewApi]);

  // Re-shape the grid when the arrangement preference changes (e.g. from the
  // settings window, synced through the storage event).
  useEffect(() => {
    const api = readLiveDockviewApi();
    if (!api) return;
    if (
      appliedArrangementRef.current &&
      arrangementsEqual(appliedArrangementRef.current, arrangement)
    ) {
      return;
    }

    applyArrangement(api, arrangement);
  }, [arrangement, applyArrangement, readLiveDockviewApi]);

  const workspaceStageStyle = useWorkspaceStageStyle();
  useCanvasToTabsHandoff(projectId);
  const collaborationEnabled = Boolean(config?.multi_agent_enabled);
  const isWorkspaceCanvasMode =
    hasProject &&
    effectiveActiveTab === 'workspace' &&
    workspaceStageStyle === 'canvas';

  // Session zone visibility follows the store flag and content availability.
  // Layout-phase so the native browser host measures the destination split
  // before the HWND is allowed to paint.
  useLayoutEffect(() => {
    const api = readLiveDockviewApi();
    if (!api || effectiveActiveTab !== 'workspace') return;

    try {
      const shouldShow =
        isRightPanelVisible && !!rightPanelContent && !isWorkspaceCanvasMode;
      const rightGroup = shouldShow
        ? (ensureSessionPanel(api) ?? getRightGroup(api))
        : getRightGroup(api);
      if (!rightGroup) {
        if (
          shouldShow &&
          !listSessionGroups(api.groups).some(
            (group) => group.panels.length > 0
          )
        ) {
          useLayoutStore.getState().setRightPanelVisible(false);
        }
        return;
      }

      setSessionDockVisible(api, getLayoutArrangement(), shouldShow);
      closeEmptyTabBarGroups(api);
    } catch (error) {
      console.warn(
        'Failed to sync session dock visibility, rebuilding layout.',
        error
      );
      if (!isDockviewApiDisposed(api)) {
        rebuildDefaultLayout(api);
      }
    }
  }, [
    effectiveActiveTab,
    ensureSessionPanel,
    isRightPanelVisible,
    isWorkspaceCanvasMode,
    readLiveDockviewApi,
    rebuildDefaultLayout,
    rightPanelContent,
  ]);

  // Collapsed editor area: hide the editor column and terminal strip. The
  // file-tree dock stays; the session column takes the leftover width.
  useEffect(() => {
    const api = readLiveDockviewApi();
    if (!api || effectiveActiveTab !== 'workspace') return;

    try {
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
        if (group.api.isVisible || group.panels.length === 0) return [];
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
      ensureWorkspacePanelsVisible(api);
      closeEmptyTabBarGroups(api);
    } catch {
      // Ignore restore failures; the workspace-tab effect retries.
    }
  }, [
    effectiveActiveTab,
    ensureWorkspacePanelsVisible,
    isWorkspaceEditorAreaCollapsed,
    readLiveDockviewApi,
  ]);

  const sessionPlacement = useMemo<SessionPanelPlacement>(
    () => ({
      host: rightPanelContent ? sessionContentHost : null,
      placement: effectiveActiveTab === 'kanban' ? 'kanban' : 'workspace',
    }),
    [effectiveActiveTab, rightPanelContent, sessionContentHost]
  );
  useWorkspaceShortcuts();

  const showZeroProjectStage =
    !hasProject && !ActiveSdkTabComponent && !activePluginTab;

  const { setChromeOccluded } = useWorkspaceOverlay();
  useLayoutEffect(() => {
    if (showZeroProjectStage || chromeHidesNativeSurface(effectiveActiveTab)) {
      setChromeOccluded(true);
      return;
    }
    const api = readLiveDockviewApi();
    if (api && !isWorkspaceEditorAreaCollapsed) {
      try {
        ensureWorkspacePanelsVisible(api);
        const shouldShow =
          isRightPanelVisible && !!rightPanelContent && !isWorkspaceCanvasMode;
        const rightGroup = shouldShow
          ? (ensureSessionPanel(api) ?? getRightGroup(api))
          : getRightGroup(api);
        if (rightGroup) {
          setSessionDockVisible(api, getLayoutArrangement(), shouldShow);
        }
        closeEmptyTabBarGroups(api);
      } catch {
        // HostBrowserPanel still waits for a stable destination slot.
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
    readLiveDockviewApi,
    rightPanelContent,
    setChromeOccluded,
    showZeroProjectStage,
  ]);
  useLayoutEffect(() => {
    return () => setChromeOccluded(false);
  }, [setChromeOccluded]);

  const canvasStageInsets = useWorkspaceStageInsets({
    enabled:
      hasProject && isLayoutScopeReady && effectiveActiveTab === 'workspace',
    apiRef,
    readyDockviewApi,
    dockviewRootRef,
    arrangement,
    isDockviewMounted,
    serializedLayout,
  });

  const showStageCreationOverlay =
    hasProject && effectiveActiveTab === 'workspace';
  const stageCreationCleanupRef = useRef<(() => void) | null>(null);
  const setStageCreationHostNode = useCallback(
    (node: HTMLDivElement | null) => {
      stageCreationCleanupRef.current?.();
      stageCreationCleanupRef.current = node
        ? registerWorkspaceStageCreationHost(node)
        : null;
    },
    []
  );

  const forwardCanvasBoundarySashPointerDown = useCallback(
    (side: 'left' | 'right', event: React.PointerEvent<HTMLDivElement>) => {
      forwardPointerDownToCanvasBoundarySash(
        dockviewRootRef.current,
        canvasStageInsets,
        side,
        event
      );
    },
    [canvasStageInsets]
  );

  const layoutBody = (
    <div className="flex min-h-0 flex-1">
      {hasProject &&
      (effectiveActiveTab === 'workspace' ||
        effectiveActiveTab === 'kanban') ? (
        <WorkspaceActivityRail
          mode={effectiveActiveTab === 'kanban' ? 'kanban' : 'workspace'}
          isEditorAreaVisible={isEditorAreaVisible}
          onToggleEditorArea={toggleEditorArea}
        />
      ) : null}

      <RightPanelSlotContext.Provider value={sessionPlacement}>
        <div
          ref={dockviewRootRef}
          className="workspace-stage-host relative flex min-h-0 flex-1 min-w-0 flex-col"
          data-canvas-stage-active={isWorkspaceCanvasMode ? 'true' : undefined}
        >
          <MobileDeviceConnectBanner />
          <GithubStarPrompt />
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
              <div
                ref={setDockviewHostNode}
                className={`tab-bar-drop-zone ${isTabBarDragOver ? 'is-drag-over' : ''}`}
                onDragOver={handleTabBarDragOver}
                onDragLeave={handleTabBarDragLeave}
                onDrop={handleTabBarDrop}
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

          {showStageCreationOverlay ? (
            <div
              ref={setStageCreationHostNode}
              data-testid="workspace-stage-creation-overlay"
              className="workspace-stage-creation-overlay pointer-events-none absolute top-0 bottom-0 z-20 min-w-0 overflow-hidden rounded-xl"
              style={{
                left: canvasStageInsets.left,
                right: canvasStageInsets.right,
                width: `calc(100% - ${canvasStageInsets.left + canvasStageInsets.right}px)`,
              }}
            />
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
        <OptionalCollaborationSpaceProvider
          enabled={collaborationEnabled}
          workspaceId={surfaceWorkspaceId}
        >
          {layoutBody}
        </OptionalCollaborationSpaceProvider>
      </ProjectLayoutScope>

      {hasProject && rightPanelContent && sessionContentHost ? (
        <RightPanelSlotContext.Provider value={sessionPlacement}>
          {createPortal(rightPanelContent, sessionContentHost)}
        </RightPanelSlotContext.Provider>
      ) : null}

      <StatusBar />
    </div>
  );
}
