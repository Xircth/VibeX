import {
  Suspense,
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from 'dockview-react';
import type { DockviewWillShowOverlayLocationEvent } from 'dockview-core';
import { Code2, FolderOpen, GitBranch, Search } from 'lucide-react';
import {
  WorkspaceDockviewTab,
  panelComponents,
} from '@/components/layout/panels/PanelRegistry';
import { StatusBar } from '@/components/layout/StatusBar';
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
import {
  applyLeftGroupHeaderHiding,
  syncDockviewGroupRegistry,
} from '@/utils/dockviewHelpers';
import {
  applyWorkspaceZoneConstraints,
  MIN_LEFT_PANEL_WIDTH,
} from '@/utils/dockviewWorkspaceConstraints';
import { DEFAULT_TERMINAL_PANEL_HEIGHT } from '@/lib/terminalPreferences';
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
  isBottomGroup,
  isEditorGroup,
  isLeftGroup,
  isSessionGroup,
  isSplittableEditorPanel,
  LEFT_PANEL_IDS,
  SESSION_PANEL_IDS,
} from '@/utils/dockviewGroupPolicy';
import DOCKVIEW_AYU_CSS from '@/styles/dockview-ayu.css?raw';

const LAYOUT = {
  // Default zone widths are fractions of the full grid width: A (dock) 20%,
  // C (session) 30%. Users can resize either column above its usable minimum;
  // that choice persists and nothing snaps it back to the defaults.
  LEFT_PANEL_DEFAULT_RATIO: 0.2,
  SESSION_PANEL_DEFAULT_RATIO: 0.3,
  LEFT_PANEL_MIN_WIDTH: MIN_LEFT_PANEL_WIDTH,
  // Frame budget for the width-stability wait in applyDefaultSizes. Window
  // restore can animate for a few hundred ms; waiting costs nothing while the
  // width is still changing.
  DEFAULT_SIZE_RETRIES: 30,
  LAYOUT_CHANGE_DEBOUNCE_MS: 500,
  IDLE_PERSIST_TIMEOUT_MS: 1000,
} as const;

/**
 * Percentage-based default widths, floored at each zone's usable minimum for
 * small windows. Percentages survive dockview's proportional rescaling, so a
 * default applied against a still-animating window width settles at the same
 * visual proportions once the window reaches its final size.
 */
function defaultDockWidth(gridWidth: number): number {
  return Math.max(
    LAYOUT.LEFT_PANEL_MIN_WIDTH,
    Math.round(gridWidth * LAYOUT.LEFT_PANEL_DEFAULT_RATIO)
  );
}

function defaultSessionWidth(gridWidth: number): number {
  return Math.max(
    MIN_RIGHT_PANEL_WIDTH,
    Math.round(gridWidth * LAYOUT.SESSION_PANEL_DEFAULT_RATIO)
  );
}

type DockviewGroup = NonNullable<ReturnType<DockviewApi['getGroup']>>;
type DockviewPanel = NonNullable<ReturnType<DockviewApi['getPanel']>>;

interface IDELayoutProps {
  rightPanelContent?: ReactNode;
  toolbarContent?: ReactNode;
}

interface TabContextMenuState {
  x: number;
  y: number;
  panelId: string;
  title: string;
}

const LazyKanbanBoard = lazy(() =>
  import('@/components/panels/DockviewKanbanPanel').then((module) => ({
    default: module.KanbanBoard,
  }))
);

function getLeftGroup(api: DockviewApi): DockviewGroup | undefined {
  return (
    api.getGroup(GROUP_IDS.LEFT) ??
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
  let previousLeft = Number.NEGATIVE_INFINITY;
  for (const slot of ['left', 'center', 'right'] as const) {
    const group = zoneGroup(api, arrangement[slot]);
    if (!group?.api.isVisible) continue;

    const rect = getGroupElement(group)?.getBoundingClientRect();
    if (!rect || rect.width <= 0) continue;

    if (rect.left <= previousLeft) return false;
    previousLeft = rect.left;
  }
  return true;
}

function hideGroupHeader(group: DockviewGroup) {
  try {
    const model = (group as { model?: { header?: { hidden?: boolean } } })
      .model;
    if (typeof model?.header?.hidden !== 'undefined') {
      model.header.hidden = true;
    }
  } catch {
    // Ignore internal model access failures and rely on CSS class fallback.
  }
  getGroupElement(group)?.classList.add('dv-header-hidden');
}

function getEditorGroups(api: DockviewApi): DockviewGroup[] {
  return api.groups
    .filter((group) => isEditorGroup(group))
    .sort(compareEditorGroups);
}

function normalizeGroupIds(api: DockviewApi) {
  const leftGroup = getLeftGroup(api);
  if (leftGroup) {
    (leftGroup as { id: string }).id = GROUP_IDS.LEFT;
  }

  const bottomGroup = getBottomGroup(api);
  if (bottomGroup) {
    (bottomGroup as { id: string }).id = GROUP_IDS.BOTTOM;
    bottomGroup.locked = 'no-drop-target';
    hideGroupHeader(bottomGroup);
  }

  const rightGroup = getRightGroup(api);
  if (rightGroup) {
    (rightGroup as { id: string }).id = GROUP_IDS.RIGHT;
    rightGroup.locked = 'no-drop-target';
    hideGroupHeader(rightGroup);
  }

  syncDockviewGroupRegistry(api);
  applyLeftGroupHeaderHiding(api);
  applyWorkspaceZoneConstraints(api);
}

function buildDefaultLayout(api: DockviewApi) {
  const welcomePanel = api.addPanel({
    id: PANEL_IDS.WELCOME,
    component: PANEL_IDS.WELCOME,
    title: 'Welcome',
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

  api.addPanel({
    id: PANEL_IDS.FILE_TREE,
    component: PANEL_IDS.FILE_TREE,
    title: 'Files',
    position: {
      referenceGroup: leftGroup,
      direction: 'within',
    },
  });

  const rightGroup = api.addGroup({
    id: GROUP_IDS.RIGHT,
    referencePanel: welcomePanel,
    direction: 'right',
    hideHeader: true,
    constraints: { minimumWidth: MIN_RIGHT_PANEL_WIDTH },
    initialWidth: defaultSessionWidth(api.width),
  });

  api.addPanel({
    id: PANEL_IDS.AI_CHAT,
    component: PANEL_IDS.AI_CHAT,
    title: 'Sessions',
    position: {
      referenceGroup: rightGroup,
      direction: 'within',
    },
    inactive: true,
  });
  rightGroup.locked = 'no-drop-target';
  if (!useLayoutStore.getState().isRightPanelVisible) {
    rightGroup.api.setVisible(false);
  }

  const bottomGroup = api.addGroup({
    id: GROUP_IDS.BOTTOM,
    referencePanel: welcomePanel,
    direction: 'below',
    locked: 'no-drop-target',
    initialHeight: DEFAULT_TERMINAL_PANEL_HEIGHT,
  });

  bottomGroup.locked = 'no-drop-target';
  api.addPanel({
    id: PANEL_IDS.TERMINAL,
    component: PANEL_IDS.TERMINAL,
    title: 'Terminal',
    position: {
      referenceGroup: bottomGroup,
      direction: 'within',
    },
    inactive: true,
  });
  bottomGroup.api.setVisible(false);

  normalizeGroupIds(api);
}

function ensureWelcomeEditorGroup(api: DockviewApi): DockviewGroup | undefined {
  const editorGroups = getEditorGroups(api);
  if (editorGroups.length > 0) {
    normalizeGroupIds(api);
    return editorGroups[0];
  }

  const existingWelcome = api.getPanel(PANEL_IDS.WELCOME);
  if (existingWelcome) {
    normalizeGroupIds(api);
    return existingWelcome.group;
  }

  const bottomGroup = getBottomGroup(api);
  const bottomReferencePanel = bottomGroup?.panels[0];
  const leftGroup = getLeftGroup(api);
  const referencePanel =
    bottomReferencePanel ??
    leftGroup?.panels[0] ??
    api.panels.find(
      (panel) =>
        !BOTTOM_PANEL_IDS.has(panel.id) && !SESSION_PANEL_IDS.has(panel.id)
    );

  const welcomePanel = api.addPanel({
    id: PANEL_IDS.WELCOME,
    component: PANEL_IDS.WELCOME,
    title: 'Welcome',
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
  normalizeGroupIds(api);
  return welcomePanel.group;
}

function resolvePanelFromTabElement(
  api: DockviewApi,
  tabElement: HTMLElement
): DockviewPanel | undefined {
  for (const group of getEditorGroups(api)) {
    const groupElement = getGroupElement(group);
    if (!groupElement || !groupElement.contains(tabElement)) {
      continue;
    }

    const tabsContainer = groupElement.querySelector('.dv-tabs-container');
    if (!tabsContainer) {
      continue;
    }

    const tabs = Array.from(tabsContainer.querySelectorAll(':scope > .dv-tab'));
    const index = tabs.indexOf(tabElement);
    if (index < 0) {
      continue;
    }

    return group.panels[index];
  }

  return undefined;
}

export function IDELayout({
  rightPanelContent,
  toolbarContent,
}: IDELayoutProps) {
  const { t } = useTranslation(['panels', 'common']);
  const { workspaceId, sessionId } = useParams<{
    workspaceId?: string;
    sessionId?: string;
  }>();
  const apiRef = useRef<DockviewApi | null>(null);
  const dockviewRootRef = useRef<HTMLDivElement>(null);
  const tabContextMenuRef = useRef<HTMLDivElement>(null);
  const { activeWorktreeId } = useWorktree();
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
  const routeTab = workspaceId || sessionId ? 'workspace' : null;
  const effectiveActiveTab = routeTab ?? activeTab;
  const serializedLayoutRef = useRef(serializedLayout);
  const layoutChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const isResettingRef = useRef(false);
  const prevSerializedLayoutRef = useRef(serializedLayout);
  const appliedArrangementRef = useRef<LayoutArrangement | null>(null);
  const lastSelfHealAtRef = useRef(0);
  const [tabContextMenu, setTabContextMenu] =
    useState<TabContextMenuState | null>(null);
  // Detached element hosting the session (C zone) content; the workspace
  // dockview panel and the kanban session slot re-parent it between them.
  const [sessionContentHost] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null;
    const element = document.createElement('div');
    element.className = 'h-full w-full min-w-0 overflow-hidden';
    return element;
  });

  const {
    setDockviewApi,
    toggleFileTree,
    toggleGitPanel,
    toggleSearchPanel,
    isPanelOpen,
    openPanelInNewEditorGroup,
    canOpenPanelInNewEditorGroup,
  } = usePanelActionsContext();

  serializedLayoutRef.current = serializedLayout;
  const isWorkspaceEditorAreaCollapsed =
    effectiveActiveTab === 'workspace' && !isEditorAreaVisible;
  const isCollapsedRef = useRef(isWorkspaceEditorAreaCollapsed);
  isCollapsedRef.current = isWorkspaceEditorAreaCollapsed;

  const applyDefaultSizes = useCallback(
    (
      api: DockviewApi,
      retries: number = LAYOUT.DEFAULT_SIZE_RETRIES,
      onDone?: () => void,
      lastWidth: number = -1
    ) => {
      // Wait until the container width is stable across two consecutive
      // frames, not merely > 0: at startup the window is still animating to
      // its restored size, and pixel sizes applied against a transient small
      // width get proportionally rescaled by dockview afterwards (an inflated
      // dock and a crushed session column), then persisted.
      if ((api.width <= 0 || api.width !== lastWidth) && retries > 0) {
        requestAnimationFrame(() =>
          applyDefaultSizes(api, retries - 1, onDone, api.width)
        );
        return;
      }

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
        applyDefaultSizes(api, LAYOUT.DEFAULT_SIZE_RETRIES, () => {
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

  // Terminal visibility captured when the kanban page force-hides the strip,
  // so returning to the workspace restores the user's previous choice.
  const terminalVisibleBeforeKanbanRef = useRef<boolean | null>(null);

  const hideWorkspaceZonesForKanban = useCallback((api: DockviewApi) => {
    const bottomGroup = getBottomGroup(api);
    if (bottomGroup) {
      if (terminalVisibleBeforeKanbanRef.current === null) {
        terminalVisibleBeforeKanbanRef.current = bottomGroup.api.isVisible;
      }
      bottomGroup.api.setVisible(false);
    }
    getLeftGroup(api)?.api.setVisible(false);
  }, []);

  const ensureWorkspacePanelsVisible = useCallback(
    (api: DockviewApi) => {
      if (effectiveActiveTab !== 'workspace' && !effectiveWorkspaceId) return;

      let leftGroup = getLeftGroup(api);
      if (!leftGroup) {
        const editorGroup =
          getEditorGroups(api)[0] ?? ensureWelcomeEditorGroup(api);
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

      if (!api.getPanel(PANEL_IDS.FILE_TREE)) {
        api.addPanel({
          id: PANEL_IDS.FILE_TREE,
          component: PANEL_IDS.FILE_TREE,
          title: 'Files',
          position: {
            referenceGroup: GROUP_IDS.LEFT,
            direction: 'within',
          },
        });
      }

      leftGroup.api.setVisible(true);

      let bottomGroup = getBottomGroup(api);
      const hadBottomGroup = !!bottomGroup;
      const wasTerminalVisible = bottomGroup?.api.isVisible ?? false;
      if (!bottomGroup) {
        const editorGroup =
          getEditorGroups(api)[0] ?? ensureWelcomeEditorGroup(api);
        const referencePanel = editorGroup?.panels[0];
        if (!referencePanel) return;

        bottomGroup = api.addGroup({
          id: GROUP_IDS.BOTTOM,
          referencePanel,
          direction: 'below',
          locked: 'no-drop-target',
          initialHeight: DEFAULT_TERMINAL_PANEL_HEIGHT,
        });
      }

      bottomGroup.locked = 'no-drop-target';
      if (!api.getPanel(PANEL_IDS.TERMINAL)) {
        api.addPanel({
          id: PANEL_IDS.TERMINAL,
          component: PANEL_IDS.TERMINAL,
          title: 'Terminal',
          position: {
            referenceGroup: GROUP_IDS.BOTTOM,
            direction: 'within',
          },
          inactive: true,
        });
      }

      // The terminal toggle owns the zone's visibility — ensure must not
      // force-show it. Only restore the pre-kanban state when returning
      // from the kanban page (which force-hides the strip).
      const restoredFromKanban = terminalVisibleBeforeKanbanRef.current;
      terminalVisibleBeforeKanbanRef.current = null;
      const shouldShowTerminal = hadBottomGroup
        ? (restoredFromKanban ?? wasTerminalVisible)
        : false;
      if (bottomGroup.api.isVisible !== shouldShowTerminal) {
        bottomGroup.api.setVisible(shouldShowTerminal);
      }
      if (shouldShowTerminal) {
        const terminalPanel = api.getPanel(PANEL_IDS.TERMINAL);
        if (terminalPanel && !terminalPanel.api.isVisible) {
          terminalPanel.api.setActive();
        }
        if (slotOfZone(getLayoutArrangement(), 'terminal') === 'bottom') {
          try {
            bottomGroup.api.setSize({ height: DEFAULT_TERMINAL_PANEL_HEIGHT });
          } catch {
            // Ignore size restoration failures during layout transitions.
          }
        }
      }
      normalizeGroupIds(api);
    },
    [effectiveActiveTab, effectiveWorkspaceId]
  );

  const ensureSessionPanel = useCallback((api: DockviewApi) => {
    let rightGroup = getRightGroup(api);
    if (!rightGroup) {
      const editorGroup =
        getEditorGroups(api)[0] ?? ensureWelcomeEditorGroup(api);
      const referencePanel = editorGroup?.panels[0];
      if (!referencePanel) return undefined;

      rightGroup = api.addGroup({
        id: GROUP_IDS.RIGHT,
        referencePanel,
        direction: 'right',
        hideHeader: true,
        constraints: { minimumWidth: MIN_RIGHT_PANEL_WIDTH },
        initialWidth: defaultSessionWidth(api.width),
      });
    }

    if (!api.getPanel(PANEL_IDS.AI_CHAT)) {
      api.addPanel({
        id: PANEL_IDS.AI_CHAT,
        component: PANEL_IDS.AI_CHAT,
        title: 'Sessions',
        position: {
          referenceGroup: rightGroup.id,
          direction: 'within',
        },
        inactive: true,
      });
    }

    rightGroup.locked = 'no-drop-target';
    normalizeGroupIds(api);
    return rightGroup;
  }, []);

  enforceTabVisibilityRef.current = (api: DockviewApi) => {
    if (effectiveActiveTab !== 'workspace') {
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

  const registerDndGuard = useCallback((api: DockviewApi) => {
    return api.onWillShowOverlay((event) => {
      const ev: DockviewWillShowOverlayLocationEvent = event;
      const targetGroup = ev.group;
      const draggedPanelId = ev.panel?.id;

      if (!targetGroup || !draggedPanelId) {
        return;
      }

      const isSourceLeftPanel = LEFT_PANEL_IDS.has(draggedPanelId);
      const isSourceBottomPanel = BOTTOM_PANEL_IDS.has(draggedPanelId);
      const isSourceSessionPanel = SESSION_PANEL_IDS.has(draggedPanelId);
      const isSourceEditorPanel =
        !isSourceLeftPanel && !isSourceBottomPanel && !isSourceSessionPanel;
      const isTargetLeftGroup = isLeftGroup(targetGroup);
      const isTargetBottomGroup = isBottomGroup(targetGroup);
      const isTargetEditorGroup = isEditorGroup(targetGroup);

      if (isSourceBottomPanel || isTargetBottomGroup) {
        event.preventDefault();
        return;
      }

      if (isSourceSessionPanel || isSessionGroup(targetGroup)) {
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
        isSourceEditorPanel &&
        isTargetEditorGroup &&
        getEditorGroups(api).length >= MAX_EDITOR_GROUPS &&
        ev.position !== 'center'
      ) {
        event.preventDefault();
      }
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

      const dndGuardDisposable = registerDndGuard(api);
      const removePanelDisposable = api.onDidRemovePanel((panel) => {
        if (isResettingRef.current) return;

        if (panel.id === PANEL_IDS.TERMINAL) {
          let bottomGroup = getBottomGroup(api);
          if (!bottomGroup) {
            const editorGroup =
              getEditorGroups(api)[0] ?? ensureWelcomeEditorGroup(api);
            const referencePanel = editorGroup?.panels[0];
            if (!referencePanel) return;

            bottomGroup = api.addGroup({
              id: GROUP_IDS.BOTTOM,
              referencePanel,
              direction: 'below',
              locked: 'no-drop-target',
              initialHeight: DEFAULT_TERMINAL_PANEL_HEIGHT,
            });
          }

          bottomGroup.locked = 'no-drop-target';
          api.addPanel({
            id: PANEL_IDS.TERMINAL,
            component: PANEL_IDS.TERMINAL,
            title: 'Terminal',
            position: {
              referenceGroup: GROUP_IDS.BOTTOM,
              direction: 'within',
            },
            inactive: true,
          });
          bottomGroup.api.setVisible(false);
          normalizeGroupIds(api);
          return;
        }

        if (panel.id === PANEL_IDS.AI_CHAT) {
          const rightGroup = ensureSessionPanel(api);
          rightGroup?.api.setVisible(
            useLayoutStore.getState().isRightPanelVisible
          );
          return;
        }

        normalizeGroupIds(api);
        if (getEditorGroups(api).length === 0) {
          ensureWelcomeEditorGroup(api);
        }
      });

      const normalizeGroupsDisposable = api.onDidAddGroup(() => {
        if (!isResettingRef.current) {
          normalizeGroupIds(api);
        }
      });

      const removeGroupDisposable = api.onDidRemoveGroup(() => {
        if (!isResettingRef.current) {
          normalizeGroupIds(api);
        }
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
            try {
              const rightGroup = getRightGroup(api);
              const sessionSlot = slotOfZone(getLayoutArrangement(), 'session');
              if (
                rightGroup?.api.isVisible &&
                sessionSlot !== 'center' &&
                sessionSlot !== 'bottom' &&
                rightGroup.api.width > 0 &&
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
        dndGuardDisposable.dispose();
        removePanelDisposable.dispose();
        normalizeGroupsDisposable.dispose();
        removeGroupDisposable.dispose();
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
      ensureSessionPanel,
      rebuildDefaultLayout,
      registerDndGuard,
      setDockviewApi,
      setRightPanelWidth,
      setSerializedLayout,
    ]
  );

  useEffect(() => {
    return () => {
      apiRef.current = null;
      setDockviewApi(null);
    };
  }, [setDockviewApi]);

  useEffect(() => {
    const previousSerializedLayout = prevSerializedLayoutRef.current;
    prevSerializedLayoutRef.current = serializedLayout;

    if (previousSerializedLayout !== null && serializedLayout === null) {
      const api = apiRef.current;
      if (!api) return;
      rebuildDefaultLayout(api);
    }
  }, [rebuildDefaultLayout, serializedLayout]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (effectiveActiveTab !== 'workspace') return;
    if (isWorkspaceEditorAreaCollapsed) return;

    const frame = requestAnimationFrame(() => {
      try {
        ensureWorkspacePanelsVisible(api);
      } catch (error) {
        console.warn(
          'Failed to restore workspace panels, rebuilding layout.',
          error
        );
        rebuildDefaultLayout(api);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [
    effectiveActiveTab,
    effectiveWorkspaceId,
    ensureWorkspacePanelsVisible,
    isWorkspaceEditorAreaCollapsed,
    rebuildDefaultLayout,
  ]);

  // The kanban board replaces the dock/workspace/terminal zones; only the
  // session zone stays interactive next to it.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || effectiveActiveTab === 'workspace') return;

    hideWorkspaceZonesForKanban(api);
  }, [effectiveActiveTab, hideWorkspaceZonesForKanban]);

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

  // Session zone visibility follows the store flag and content availability.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    const shouldShow = isRightPanelVisible && !!rightPanelContent;
    const rightGroup =
      getRightGroup(api) ?? (shouldShow ? ensureSessionPanel(api) : undefined);
    if (!rightGroup) return;

    if (rightGroup.api.isVisible !== shouldShow) {
      rightGroup.api.setVisible(shouldShow);
    }
  }, [ensureSessionPanel, isRightPanelVisible, rightPanelContent]);

  // Collapsed editor area: hide every zone except the session zone so it can
  // take over the full dockview canvas.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || effectiveActiveTab !== 'workspace') return;

    if (isWorkspaceEditorAreaCollapsed) {
      getLeftGroup(api)?.api.setVisible(false);
      getBottomGroup(api)?.api.setVisible(false);
      for (const group of getEditorGroups(api)) {
        group.api.setVisible(false);
      }
      return;
    }

    for (const group of getEditorGroups(api)) {
      if (!group.api.isVisible) {
        group.api.setVisible(true);
      }
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

  useEffect(() => {
    const root = dockviewRootRef.current;
    if (!root) return;

    const handleContextMenu = (event: MouseEvent) => {
      const api = apiRef.current;
      const target = event.target as HTMLElement | null;
      const tabElement = target?.closest('.dv-tab') as HTMLElement | null;

      if (!api || !tabElement) {
        return;
      }

      const panel = resolvePanelFromTabElement(api, tabElement);
      if (!panel || !isSplittableEditorPanel(panel)) {
        return;
      }

      event.preventDefault();
      setTabContextMenu({
        x: event.clientX,
        y: event.clientY,
        panelId: panel.id,
        title: panel.title ?? panel.id,
      });
    };

    root.addEventListener('contextmenu', handleContextMenu);
    return () => root.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  useEffect(() => {
    if (!tabContextMenu) return;

    const dismiss = () => setTabContextMenu(null);
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && tabContextMenuRef.current?.contains(target)) {
        return;
      }
      dismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismiss();
      }
    };

    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [tabContextMenu]);

  useEffect(() => {
    const styleId = 'dockview-ayu-overrides';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = DOCKVIEW_AYU_CSS;
    document.head.appendChild(style);

    return () => {
      style.remove();
    };
  }, []);

  useWorkspaceShortcuts();

  return (
    <div className="workspace-shell flex h-full w-full flex-col">
      <SearchPalette />
      {toolbarContent && (
        <div className="workspace-divider-bottom z-10 shrink-0">
          {toolbarContent}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {effectiveActiveTab === 'workspace' ? (
          <div className="workspace-activity-rail flex w-10 shrink-0 flex-col items-center gap-0.5 pt-1">
            <button
              onClick={toggleFileTree}
              className={`workspace-activity-button flex h-9 w-9 items-center justify-center transition-colors ${
                isPanelOpen(PANEL_IDS.FILE_TREE) ? 'is-active' : ''
              }`}
              title="Files"
            >
              <FolderOpen className="h-[18px] w-[18px]" />
            </button>
            <button
              onClick={toggleGitPanel}
              className={`workspace-activity-button flex h-9 w-9 items-center justify-center transition-colors ${
                isPanelOpen(PANEL_IDS.GIT) ? 'is-active' : ''
              }`}
              title="Git"
            >
              <GitBranch className="h-[18px] w-[18px]" />
            </button>
            <button
              onClick={toggleSearchPanel}
              className={`workspace-activity-button flex h-9 w-9 items-center justify-center transition-colors ${
                isPanelOpen(PANEL_IDS.SEARCH) ? 'is-active' : ''
              }`}
              title="Search (Ctrl+Shift+F)"
            >
              <Search className="h-[18px] w-[18px]" />
            </button>
            <button
              onClick={toggleEditorArea}
              className={`workspace-activity-button hidden h-9 w-9 items-center justify-center transition-colors ${
                isEditorAreaVisible ? 'is-active' : ''
              }`}
              title={
                isEditorAreaVisible
                  ? t('ideLayout.hideEditorAndTerminal')
                  : t('ideLayout.showEditorAndTerminal')
              }
              aria-pressed={isEditorAreaVisible}
            >
              <Code2 className="h-[18px] w-[18px]" />
            </button>
          </div>
        ) : null}

        <RightPanelSlotContext.Provider value={sessionPlacement}>
          <div className="relative flex-1 min-w-0" ref={dockviewRootRef}>
            <div className="h-full">
              <DockviewReact
                components={panelComponents}
                defaultTabComponent={WorkspaceDockviewTab}
                onReady={handleReady}
                className="dockview-theme-light dockview-theme-ayu"
                disableFloatingGroups={true}
              />
            </div>

            {effectiveActiveTab === 'kanban' && (
              <div className="kanban-overlay absolute inset-0 z-10">
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
              </div>
            )}

            {tabContextMenu && (
              <div
                ref={tabContextMenuRef}
                className="fixed z-50 min-w-56 rounded-md border border-border bg-popover p-1 shadow-lg"
                style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
              >
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  {tabContextMenu.title}
                </div>
                <button
                  type="button"
                  className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={
                    !canOpenPanelInNewEditorGroup(tabContextMenu.panelId)
                  }
                  onClick={() => {
                    openPanelInNewEditorGroup(tabContextMenu.panelId);
                    setTabContextMenu(null);
                  }}
                >
                  {t('ideLayout.openInNewEditorGroup')}
                </button>
              </div>
            )}
          </div>
        </RightPanelSlotContext.Provider>
      </div>

      {rightPanelContent && sessionContentHost
        ? createPortal(rightPanelContent, sessionContentHost)
        : null}

      <StatusBar />
    </div>
  );
}
