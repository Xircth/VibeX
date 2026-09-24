import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DockviewApi } from 'dockview-react';
import {
  GROUP_IDS,
  MAX_EDITOR_GROUPS,
  PANEL_IDS,
  useLayoutStore,
} from '@/stores/useLayoutStore';
import { useCommitDiffStore } from '@/stores/useCommitDiffStore';
import {
  applyLeftGroupHeaderHiding,
  syncDockviewGroupRegistry,
} from '@/utils/dockviewHelpers';
import { preloadMonacoEditor } from '@/lib/monacoPreload';
import { backendCall, backendListen } from '@/lib/backendTransport';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import {
  pluginSurfaceId,
  shouldOpenContributedPanel,
} from '@/lib/hostSurfaceIds';
import { useBackendTransport } from '@/lib/transport';
import { findHostBrowserContribution } from '@/features/host-browser/hostBrowserEngine';
import { applyBrowserHostEvent } from '@/features/host-browser/browserChromeStore';
import {
  ensureBrowserTabOpenBridge,
  setBrowserTabOpenHandler,
} from '@/features/host-browser/openBrowserTab';
import { DEFAULT_TERMINAL_PANEL_HEIGHT } from '@/lib/terminalPreferences';
import {
  editorTerminalPanelId,
  tabIdFromEditorTerminalPanelId,
} from '@/lib/workspaceTerminalTabs';
import {
  generateTerminalTabId,
  useTerminalStore,
} from '@/stores/useTerminalStore';
import {
  buildPreviewPanelParams,
  type OpenFilePreviewOptions,
  type OpenFilePreviewResult,
} from '@/types/panels';
import { useGitDiffNavigationStore } from '@/stores/useGitDiffNavigationStore';
import {
  BOTTOM_PANEL_IDS,
  compareEditorGroups,
  getGroupElement,
  getNextEditorGroupId,
  isBottomGroup,
  isEditorGroup,
  isLeftGroup,
  isPlaceholderPanelId,
  isSessionGroup,
  isSplittableEditorPanel,
  LEFT_PANEL_IDS,
  listLeftDockGroups,
} from '@/utils/dockviewGroupPolicy';
import { getLayoutArrangement, slotOfZone } from '@/lib/layoutArrangement';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import {
  applyWorkspaceZoneConstraints,
  MIN_LEFT_PANEL_WIDTH,
} from '@/utils/dockviewWorkspaceConstraints';
import {
  ACTIVITY_RAIL_ITEMS,
  ACTIVITY_RAIL_PANEL_TITLES,
  type ActivityRailItemId,
} from '@/lib/activityRailOrder';
import {
  applyLeftDockSplitSizes,
  isLeftDockSplit as readLeftDockSplit,
  measureLeftDockBox,
  syncLeftDockSplitFromLayout,
  unsplitLeftDockKeepLeading,
} from '@/lib/leftDockPlacement';
import {
  dropZoneToDirection,
  isRowSplit,
  type LeftPanelDropZone,
} from '@/lib/leftPanelSplit';
import {
  ensureWelcomeEditorGroup,
  isEditorColumnCrushed,
  restoreFlexibleEditorColumn,
  setColumnVisible,
  setLeftDockVisible,
} from '@/utils/dockviewEditorGroup';
import {
  clearImagePreviewSources,
  registerImagePreviewSource,
  releaseImagePreviewSource,
} from '@/lib/imagePreviewRegistry';

const DIFF_PREVIEW_PANEL_ID_PREFIX = 'diff:';
const MAX_OPEN_DIFF_PREVIEW_PANELS = 5;

type RevealInFileTreeOptions = {
  displayPath?: string | null;
  nodeType?: 'file' | 'folder';
};

type AddPanelOptions = Omit<
  Parameters<DockviewApi['addPanel']>[0],
  'position' | 'floating'
>;

function buildDiffPreviewPanelId(filePath: string): string {
  return `${DIFF_PREVIEW_PANEL_ID_PREFIX}${filePath.replace(/\\/g, '/')}`;
}

// Stable id for image-URL preview panels; URLs (data:/proxy) can be far too
// long to embed in a dockview panel id, so hash them instead.
function buildImagePreviewPanelId(imageUrl: string): string {
  let hash = 5381;
  for (let i = 0; i < imageUrl.length; i++) {
    hash = ((hash << 5) + hash + imageUrl.charCodeAt(i)) | 0;
  }
  return `image:${(hash >>> 0).toString(36)}`;
}

function buildSplitPanelId(panelId: string, targetGroupId: string): string {
  return `${panelId}::split::${targetGroupId}`;
}

function isDiffPreviewPanelId(panelId: string): boolean {
  return panelId.startsWith(DIFF_PREVIEW_PANEL_ID_PREFIX);
}

function closeRemovedEditorTerminal(panelId: string): void {
  const tabId = tabIdFromEditorTerminalPanelId(panelId);
  if (!tabId) {
    return;
  }

  const store = useTerminalStore.getState();
  for (const [workspaceId, sessions] of Object.entries(
    store.sessionsByWorkspace
  )) {
    const session = sessions.find((item) => item.tabId === tabId);
    if (!session || session.surface !== 'editor') {
      continue;
    }

    if (session.sessionId && !session.readOnly) {
      void backendCall('close_terminal', {
        sessionId: session.sessionId,
      }).catch((error) => {
        console.error('Failed to close terminal session:', error);
      });
    }

    store.removeSession(workspaceId, tabId);
    return;
  }
}

export interface PanelActions {
  openOrFocusPanel: (panelId: string, title: string) => void;
  openFilePreview: (
    filePath: string,
    options?: OpenFilePreviewOptions
  ) => OpenFilePreviewResult;
  openImagePreview: (
    imageUrl: string,
    options?: { title?: string | null }
  ) => void;
  openWebPreview: (url?: string | null) => void;
  revealInFileTree: (path: string, options?: RevealInFileTreeOptions) => void;
  openDiffPreview: () => void;
  openDiffPreviewAtPath: (
    path: string,
    options?: OpenFilePreviewOptions & { title?: string }
  ) => void;
  openMergePanel: (params: {
    workspaceId: string;
    repoId: string;
    filePath: string;
  }) => void;
  openCommitDiff: () => void;
  openNewTerminal: () => void;
  openTerminalEditorTab: () => void;
  showTerminal: () => void;
  toggleEditorArea: () => void;
  openPanelInNewEditorGroup: (panelId: string) => boolean;
  canOpenPanelInNewEditorGroup: (panelId: string) => boolean;
  splitActiveEditor: () => boolean;
  canSplitActiveEditor: () => boolean;
  closePanel: (panelId: string) => void;
  toggleFileTree: () => void;
  showFileTree: () => void;
  toggleGitPanel: () => void;
  toggleSearchPanel: () => void;
  toggleSessionList: () => void;
  placeLeftDockPanel: (
    panelId: ActivityRailItemId,
    zone: LeftPanelDropZone
  ) => void;
  measureLeftDock: () => {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  isLeftDockSplit: () => boolean;
  unsplitLeftDock: () => void;
  isPanelOpen: (panelId: string) => boolean;
  focusKanban: () => void;
  openLogs: () => void;
  openNotes: () => void;
  openPluginPanel: (options: {
    panelId?: string;
    title: string;
    pluginId: string;
    contributionId: string;
    icon?: string | null;
    activate?: boolean;
    multiInstance?: boolean;
    instance?: 'new' | 'focus';
    requestedUrl?: string | null;
    nativeTabId?: string | null;
  }) => void;
  setDockviewApi: (api: DockviewApi | null) => void;
}

const PanelActionsContext = createContext<PanelActions | null>(null);

export function PanelActionsProvider({ children }: { children: ReactNode }) {
  const apiRef = useRef<DockviewApi | null>(null);
  const [dockviewEpoch, setDockviewEpoch] = useState(0);
  const [leftDockRevision, setLeftDockRevision] = useState(0);
  const offeredPluginPanelsRef = useRef(new Set<string>());
  const pendingBrowserOpensRef = useRef<
    Array<{ url?: string | null; nativeTabId?: string | null }>
  >([]);
  const openPluginPanelRef = useRef<
    ((options: {
      title: string;
      pluginId: string;
      contributionId: string;
      icon?: string | null;
      multiInstance?: boolean;
      instance?: 'new' | 'focus';
      requestedUrl?: string | null;
      nativeTabId?: string | null;
    }) => void) | null
  >(null);
  const pluginPanels = usePluginHostContributions('app_panel');
  const pluginPanelsRef = useRef(pluginPanels);
  pluginPanelsRef.current = pluginPanels;
  const imagePanelRemovalDisposableRef = useRef<{
    dispose: () => void;
  } | null>(null);
  const layoutDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const leftSplitSnapshotRef = useRef<{
    split: 'stack' | 'row';
    total: number;
    first: number;
  } | null>(null);
  const applyingLeftSplitRef = useRef(false);
  const diffPreviewPanelQueueRef = useRef<string[]>([]);
  const clearCommitDiff = useCommitDiffStore((state) => state.clearCommitDiff);
  const clearGitDiffTargetPath = useGitDiffNavigationStore(
    (state) => state.clearTargetPath
  );
  const setFileTreeVisible = useLayoutStore(
    (state) => state.setFileTreeVisible
  );
  const revealInTree = useFileTreeStore((state) => state.revealInTree);
  const setSelectedFilePath = useFileTreeStore(
    (state) => state.setSelectedFilePath
  );
  const transport = useBackendTransport();
  const canOpenWebPreview = transport.environment === 'desktop';

  const setDockviewApi = useCallback((api: DockviewApi | null) => {
    imagePanelRemovalDisposableRef.current?.dispose();
    imagePanelRemovalDisposableRef.current = null;
    layoutDisposableRef.current?.dispose();
    layoutDisposableRef.current = null;
    leftSplitSnapshotRef.current = null;
    apiRef.current = api;
    setDockviewEpoch((epoch) => epoch + 1);
    if (!api) {
      diffPreviewPanelQueueRef.current = [];
      clearImagePreviewSources();
      return;
    }

    imagePanelRemovalDisposableRef.current = api.onDidRemovePanel((panel) => {
      releaseImagePreviewSource(panel.id);
      closeRemovedEditorTerminal(panel.id);
    });

    let frame = 0;
    const syncSplit = () => {
      frame = 0;
      applyingLeftSplitRef.current = true;
      leftSplitSnapshotRef.current = syncLeftDockSplitFromLayout(
        api,
        leftSplitSnapshotRef.current
      );
      requestAnimationFrame(() => {
        applyingLeftSplitRef.current = false;
      });
    };
    layoutDisposableRef.current = api.onDidLayoutChange(() => {
      if (applyingLeftSplitRef.current) return;
      if (frame) return;
      frame = requestAnimationFrame(syncSplit);
    });
  }, []);

  useEffect(
    () => () => {
      imagePanelRemovalDisposableRef.current?.dispose();
      imagePanelRemovalDisposableRef.current = null;
      layoutDisposableRef.current?.dispose();
      layoutDisposableRef.current = null;
      clearImagePreviewSources();
    },
    []
  );

  const getLeftGroup = useCallback((dockviewApi: DockviewApi) => {
    return (
      dockviewApi.getGroup(GROUP_IDS.LEFT) ??
      dockviewApi.groups.find((group) => isLeftGroup(group))
    );
  }, []);

  const getBottomGroup = useCallback((dockviewApi: DockviewApi) => {
    return (
      dockviewApi.getGroup(GROUP_IDS.BOTTOM) ??
      dockviewApi.groups.find((group) => isBottomGroup(group))
    );
  }, []);

  const getEditorGroups = useCallback((dockviewApi: DockviewApi) => {
    return dockviewApi.groups
      .filter((group) => isEditorGroup(group))
      .sort(compareEditorGroups);
  }, []);

  const getRightGroup = useCallback((dockviewApi: DockviewApi) => {
    return (
      dockviewApi.getGroup(GROUP_IDS.RIGHT) ??
      dockviewApi.groups.find((group) => isSessionGroup(group))
    );
  }, []);

  const normalizeEditorGroupIds = useCallback(
    (dockviewApi: DockviewApi) => {
      const leftGroups = listLeftDockGroups(dockviewApi.groups);
      if (leftGroups.length === 1) {
        (leftGroups[0] as { id: string }).id = GROUP_IDS.LEFT;
      }

      const bottomGroup = getBottomGroup(dockviewApi);
      if (bottomGroup) {
        (bottomGroup as { id: string }).id = GROUP_IDS.BOTTOM;
        bottomGroup.locked = 'no-drop-target';
        try {
          const model = (
            bottomGroup as {
              model?: { header?: { hidden?: boolean } };
            }
          ).model;
          if (typeof model?.header?.hidden !== 'undefined') {
            model.header.hidden = true;
          }
        } catch {
          // Ignore internal model access failures and rely on CSS class fallback.
        }
        getGroupElement(bottomGroup)?.classList.add('dv-header-hidden');
      }

      const rightGroup = getRightGroup(dockviewApi);
      if (rightGroup) {
        (rightGroup as { id: string }).id = GROUP_IDS.RIGHT;
        rightGroup.locked = 'no-drop-target';
        try {
          const model = (
            rightGroup as {
              model?: { header?: { hidden?: boolean } };
            }
          ).model;
          if (typeof model?.header?.hidden !== 'undefined') {
            model.header.hidden = true;
          }
        } catch {
          // Ignore internal model access failures and rely on CSS class fallback.
        }
        getGroupElement(rightGroup)?.classList.add('dv-header-hidden');
      }

      syncDockviewGroupRegistry(dockviewApi);
      applyLeftGroupHeaderHiding(dockviewApi);
    },
    [getBottomGroup, getRightGroup]
  );

  const recreateWelcomeEditorGroup = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return undefined;

    const group = ensureWelcomeEditorGroup(dockviewApi, {
      arrangement: getLayoutArrangement(),
      sessionWidth: useLayoutStore.getState().rightPanelWidth,
    });
    normalizeEditorGroupIds(dockviewApi);
    return group;
  }, [normalizeEditorGroupIds]);

  const getActiveEditorGroup = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return undefined;

    if (dockviewApi.activeGroup && isEditorGroup(dockviewApi.activeGroup)) {
      return dockviewApi.activeGroup;
    }

    if (
      dockviewApi.activePanel &&
      isEditorGroup(dockviewApi.activePanel.group)
    ) {
      return dockviewApi.activePanel.group;
    }

    return getEditorGroups(dockviewApi)[0] ?? recreateWelcomeEditorGroup();
  }, [getEditorGroups, recreateWelcomeEditorGroup]);

  const addPanelToActiveEditorGroup = useCallback(
    (options: AddPanelOptions) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return undefined;

      const targetGroup = getActiveEditorGroup();
      if (!targetGroup) return undefined;

      targetGroup.api.setVisible(true);

      if (isEditorColumnCrushed(dockviewApi)) {
        const leftGroup = getLeftGroup(dockviewApi);
        restoreFlexibleEditorColumn(
          dockviewApi,
          getLayoutArrangement(),
          useLayoutStore.getState().rightPanelWidth,
          leftGroup?.api.isVisible ? leftGroup.api.width : undefined
        );
      }

      const placeholderPanels = targetGroup.panels.filter((panel) =>
        isPlaceholderPanelId(panel.id)
      );

      const panel = dockviewApi.addPanel({
        ...options,
        renderer:
          options.component === PANEL_IDS.PREVIEW ||
          options.component === 'plugin-panel' ||
          options.component === PANEL_IDS.TERMINAL
            ? 'onlyWhenVisible'
            : options.renderer,
        position: {
          referenceGroup: targetGroup,
          direction: 'within',
          ...(placeholderPanels.length > 0 ? { index: 0 } : {}),
        },
      });

      for (const placeholder of placeholderPanels) {
        const current = dockviewApi.getPanel(placeholder.id);
        if (current) {
          try {
            dockviewApi.removePanel(current);
          } catch {
            // Ignore placeholder cleanup failures during layout transitions.
          }
        }
      }

      normalizeEditorGroupIds(dockviewApi);
      return panel;
    },
    [getActiveEditorGroup, getLeftGroup, normalizeEditorGroupIds]
  );

  const openFilePreview = useCallback(
    (
      filePath: string,
      options?: OpenFilePreviewOptions
    ): OpenFilePreviewResult => {
      void preloadMonacoEditor();
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return 'unavailable';

      // Absent an explicit choice, opening a file is the user asking for it.
      const activate = options?.activate ?? true;

      if (activate) {
        setSelectedFilePath(filePath);
        revealInTree(filePath, 'file');
      }

      const panelId = `file:${filePath}`;
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      const title = options?.title ?? options?.displayPath ?? fileName;
      const params = buildPreviewPanelParams(filePath, options);

      const existingPanel = dockviewApi.getPanel(panelId);
      if (existingPanel) {
        existingPanel.api.updateParameters(params);
        if (existingPanel.title !== title) {
          existingPanel.api.setTitle(title);
        }
        existingPanel.group.api.setVisible(true);
        if (activate) {
          existingPanel.api.setActive();
        }
        return 'focused';
      }

      const panel = addPanelToActiveEditorGroup({
        id: panelId,
        component: PANEL_IDS.PREVIEW,
        title,
        params,
      });

      if (!panel) return 'unavailable';

      if (activate) {
        panel.api.setActive();
      }
      return 'opened';
    },
    [addPanelToActiveEditorGroup, revealInTree, setSelectedFilePath]
  );

  const openImagePreview = useCallback(
    (imageUrl: string, options?: { title?: string | null }) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      const panelId = buildImagePreviewPanelId(imageUrl);
      const title = options?.title?.trim() || 'Image';
      registerImagePreviewSource(panelId, imageUrl);
      const params = {
        filePath: '',
        mode: 'editor',
        diffViewMode: 'split',
        modifiedContent: null,
        originalContent: null,
        displayPath: options?.title ?? null,
        location: null,
        imagePreviewId: panelId,
      };

      const existingPanel = dockviewApi.getPanel(panelId);
      if (existingPanel) {
        existingPanel.api.updateParameters(params);
        if (existingPanel.title !== title) {
          existingPanel.api.setTitle(title);
        }
        existingPanel.group.api.setVisible(true);
        existingPanel.api.setActive();
        return;
      }

      const panel = addPanelToActiveEditorGroup({
        id: panelId,
        component: PANEL_IDS.PREVIEW,
        title,
        params,
      });

      panel?.api.setActive();
    },
    [addPanelToActiveEditorGroup]
  );

  const syncDiffPreviewPanelQueue = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) {
      diffPreviewPanelQueueRef.current = [];
      return;
    }

    diffPreviewPanelQueueRef.current = diffPreviewPanelQueueRef.current.filter(
      (panelId) => !!dockviewApi.getPanel(panelId)
    );
  }, []);

  const markDiffPreviewPanelAsRecent = useCallback(
    (panelId: string) => {
      syncDiffPreviewPanelQueue();
      diffPreviewPanelQueueRef.current = [
        ...diffPreviewPanelQueueRef.current.filter((id) => id !== panelId),
        panelId,
      ];
    },
    [syncDiffPreviewPanelQueue]
  );

  const enforceDiffPreviewPanelLimit = useCallback(
    (keepPanelId?: string) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      syncDiffPreviewPanelQueue();

      while (
        diffPreviewPanelQueueRef.current.length > MAX_OPEN_DIFF_PREVIEW_PANELS
      ) {
        const oldestPanelId = diffPreviewPanelQueueRef.current[0];
        if (!oldestPanelId) break;

        // Keep the just-opened panel when trimming the queue.
        if (
          keepPanelId &&
          oldestPanelId === keepPanelId &&
          diffPreviewPanelQueueRef.current.length > 1
        ) {
          diffPreviewPanelQueueRef.current = [
            ...diffPreviewPanelQueueRef.current.slice(1),
            oldestPanelId,
          ];
          continue;
        }

        diffPreviewPanelQueueRef.current =
          diffPreviewPanelQueueRef.current.slice(1);

        const oldestPanel = dockviewApi.getPanel(oldestPanelId);
        if (!oldestPanel) {
          continue;
        }

        try {
          dockviewApi.removePanel(oldestPanel);
        } catch {
          // Ignore failures caused by concurrent panel transitions.
        }
      }
    },
    [syncDiffPreviewPanelQueue]
  );

  const replaceDiffPreviewPanelQueueId = useCallback(
    (fromPanelId: string, toPanelId: string) => {
      if (!isDiffPreviewPanelId(fromPanelId)) {
        return;
      }

      diffPreviewPanelQueueRef.current = diffPreviewPanelQueueRef.current.map(
        (panelId) => (panelId === fromPanelId ? toPanelId : panelId)
      );
    },
    []
  );

  const applyDefaultTerminalHeight = useCallback(
    (bottomGroup: NonNullable<ReturnType<DockviewApi['getGroup']>>) => {
      // Only meaningful while the terminal zone is the bottom strip; when the
      // arrangement moves it into a column its height is the full grid.
      if (slotOfZone(getLayoutArrangement(), 'terminal') !== 'bottom') return;

      try {
        bottomGroup.api.setSize({ height: DEFAULT_TERMINAL_PANEL_HEIGHT });
      } catch {
        // Ignore resize failures while the layout is settling.
      }
    },
    []
  );

  const setTerminalVisibility = useCallback(
    (toggleExisting: boolean) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      const existingTerminal = dockviewApi.getPanel(PANEL_IDS.TERMINAL);
      let bottomGroup = getBottomGroup(dockviewApi);

      if (existingTerminal && bottomGroup) {
        const nextVisible = toggleExisting ? !bottomGroup.api.isVisible : true;
        bottomGroup.api.setVisible(nextVisible);
        if (nextVisible) {
          existingTerminal.api.setActive();
          applyDefaultTerminalHeight(bottomGroup);
        }
        return;
      }

      if (bottomGroup && !existingTerminal) {
        bottomGroup.api.setVisible(true);
        const terminalPanel = dockviewApi.addPanel({
          id: PANEL_IDS.TERMINAL,
          component: PANEL_IDS.TERMINAL,
          title: 'Terminal',
          renderer: 'onlyWhenVisible',
          position: { referenceGroup: GROUP_IDS.BOTTOM, direction: 'within' },
        });
        terminalPanel.api.setActive();
        applyDefaultTerminalHeight(bottomGroup);
        normalizeEditorGroupIds(dockviewApi);
        return;
      }

      if (existingTerminal && !bottomGroup) {
        // The terminal panel exists but its group wasn't recognized (e.g. a
        // transient state during a layout transform): control its own group
        // instead of re-adding a duplicate panel, which would throw.
        const group = existingTerminal.group;
        const nextVisible = toggleExisting ? !group.api.isVisible : true;
        group.api.setVisible(nextVisible);
        if (nextVisible) {
          existingTerminal.api.setActive();
        }
        return;
      }

      const targetGroup =
        getEditorGroups(dockviewApi)[0] ?? recreateWelcomeEditorGroup();
      const referencePanel = targetGroup?.panels[0];
      if (!referencePanel) return;

      bottomGroup = dockviewApi.addGroup({
        id: GROUP_IDS.BOTTOM,
        referencePanel,
        direction: 'below',
        locked: 'no-drop-target',
        initialHeight: DEFAULT_TERMINAL_PANEL_HEIGHT,
      });
      bottomGroup.locked = 'no-drop-target';

      const terminalPanel = dockviewApi.addPanel({
        id: PANEL_IDS.TERMINAL,
        component: PANEL_IDS.TERMINAL,
        title: 'Terminal',
        renderer: 'onlyWhenVisible',
        position: { referenceGroup: GROUP_IDS.BOTTOM, direction: 'within' },
      });
      terminalPanel.api.setActive();
      applyDefaultTerminalHeight(bottomGroup);

      normalizeEditorGroupIds(dockviewApi);
    },
    [
      applyDefaultTerminalHeight,
      recreateWelcomeEditorGroup,
      getBottomGroup,
      getEditorGroups,
      normalizeEditorGroupIds,
    ]
  );

  const openNewTerminal = useCallback(
    () => setTerminalVisibility(true),
    [setTerminalVisibility]
  );

  const showTerminal = useCallback(
    () => setTerminalVisibility(false),
    [setTerminalVisibility]
  );

  const openTerminalEditorTab = useCallback(() => {
    const tabId = generateTerminalTabId();
    const panel = addPanelToActiveEditorGroup({
      id: editorTerminalPanelId(tabId),
      component: PANEL_IDS.TERMINAL,
      title: 'Terminal',
      params: {
        surface: 'editor',
        tabId,
      },
    });
    panel?.api.setActive();
  }, [addPanelToActiveEditorGroup]);

  const toggleEditorArea = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return;

    const editorGroups = getEditorGroups(dockviewApi);
    if (editorGroups.length === 0) {
      const welcomeGroup = recreateWelcomeEditorGroup();
      welcomeGroup?.api.setVisible(true);
      dockviewApi.getPanel(PANEL_IDS.WELCOME)?.api.setActive();
      return;
    }

    const activeEditorGroup =
      dockviewApi.activeGroup && isEditorGroup(dockviewApi.activeGroup)
        ? dockviewApi.activeGroup
        : editorGroups[0];

    activeEditorGroup?.api.setVisible(true);

    const focusPanel =
      activeEditorGroup?.activePanel ??
      activeEditorGroup?.panels[0] ??
      dockviewApi.getPanel(PANEL_IDS.WELCOME);

    if (focusPanel) {
      focusPanel.api.setActive();
    } else {
      const welcomeGroup = recreateWelcomeEditorGroup();
      welcomeGroup?.api.setVisible(true);
      dockviewApi.getPanel(PANEL_IDS.WELCOME)?.api.setActive();
    }

    normalizeEditorGroupIds(dockviewApi);
  }, [getEditorGroups, normalizeEditorGroupIds, recreateWelcomeEditorGroup]);

  const canOpenPanelInNewEditorGroup = useCallback(
    (panelId: string) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return false;

      const panel = dockviewApi.getPanel(panelId);
      if (!panel || !isSplittableEditorPanel(panel)) {
        return false;
      }

      const state = panel.toJSON();
      if (!state.contentComponent) {
        return false;
      }

      return getEditorGroups(dockviewApi).length < MAX_EDITOR_GROUPS;
    },
    [getEditorGroups]
  );

  const openPanelInNewEditorGroup = useCallback(
    (panelId: string) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi || !canOpenPanelInNewEditorGroup(panelId)) {
        return false;
      }

      const panel = dockviewApi.getPanel(panelId);
      if (!panel) {
        return false;
      }

      const panelState = panel.toJSON();
      if (!panelState.contentComponent) {
        return false;
      }

      const newGroup = dockviewApi.addGroup({
        id: getNextEditorGroupId(dockviewApi),
        referencePanel: panel,
        direction: 'right',
        skipSetActive: true,
      });

      const splitPanelId = buildSplitPanelId(panelId, newGroup.id);

      try {
        dockviewApi.addPanel({
          id: splitPanelId,
          component: panelState.contentComponent,
          tabComponent: panelState.tabComponent,
          title: panel.title,
          params: panel.params,
          renderer: panelState.renderer,
          minimumWidth: panel.minimumWidth,
          minimumHeight: panel.minimumHeight,
          maximumWidth: panel.maximumWidth,
          maximumHeight: panel.maximumHeight,
          position: {
            referenceGroup: newGroup,
            direction: 'within',
          },
        });
      } catch {
        try {
          dockviewApi.removeGroup(newGroup);
        } catch {
          // Ignore cleanup failures.
        }
        return false;
      }

      const duplicatedPanel = dockviewApi.getPanel(splitPanelId);
      if (!duplicatedPanel || duplicatedPanel.group !== newGroup) {
        try {
          dockviewApi.removeGroup(newGroup);
        } catch {
          // Ignore cleanup failures.
        }
        return false;
      }

      newGroup.api.setVisible(true);
      normalizeEditorGroupIds(dockviewApi);
      duplicatedPanel.api.setActive();

      try {
        dockviewApi.removePanel(panel);
      } catch {
        try {
          dockviewApi.removePanel(duplicatedPanel);
        } catch {
          // Ignore cleanup failures.
        }
        try {
          dockviewApi.removeGroup(newGroup);
        } catch {
          // Ignore cleanup failures.
        }
        return false;
      }

      replaceDiffPreviewPanelQueueId(panelId, splitPanelId);
      return true;
    },
    [
      canOpenPanelInNewEditorGroup,
      normalizeEditorGroupIds,
      replaceDiffPreviewPanelQueueId,
    ]
  );

  const splitActiveEditor = useCallback(() => {
    const dockviewApi = apiRef.current;
    const activePanel = dockviewApi?.activePanel;
    if (!activePanel) {
      return false;
    }

    return openPanelInNewEditorGroup(activePanel.id);
  }, [openPanelInNewEditorGroup]);

  const canSplitActiveEditor = useCallback(() => {
    const dockviewApi = apiRef.current;
    const activePanel = dockviewApi?.activePanel;
    return activePanel ? canOpenPanelInNewEditorGroup(activePanel.id) : false;
  }, [canOpenPanelInNewEditorGroup]);

  const closePanel = useCallback((panelId: string) => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return;

    const panel = dockviewApi.getPanel(panelId);
    if (!panel) return;

    dockviewApi.removePanel(panel);
  }, []);

  const ensureLeftDockGroup = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return null;

    const existingLeftGroup = getLeftGroup(dockviewApi);
    const savedLeftWidth = existingLeftGroup?.api.isVisible
      ? existingLeftGroup.api.width
      : 0;

    let leftGroup = existingLeftGroup ?? null;
    if (!leftGroup) {
      const editorHost = recreateWelcomeEditorGroup();
      const referencePanel = editorHost?.panels[0];
      if (!referencePanel) return null;

      leftGroup = dockviewApi.addGroup({
        id: GROUP_IDS.LEFT,
        referencePanel,
        direction: 'left',
        hideHeader: true,
        constraints: { minimumWidth: MIN_LEFT_PANEL_WIDTH },
        initialWidth: savedLeftWidth > 0 ? savedLeftWidth : 200,
      });

      if (savedLeftWidth > 0) {
        try {
          leftGroup.api.setSize({ width: savedLeftWidth });
        } catch {
          // Ignore resize failures during initialization.
        }
      }
    }

    return leftGroup;
  }, [getLeftGroup, recreateWelcomeEditorGroup]);

  const finishLeftDockChange = useCallback(
    (zone?: LeftPanelDropZone) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;
      applyLeftGroupHeaderHiding(dockviewApi);
      applyWorkspaceZoneConstraints(dockviewApi);
      if (zone) {
        applyingLeftSplitRef.current = true;
        applyLeftDockSplitSizes(
          dockviewApi,
          isRowSplit(zone) ? 'row' : 'stack'
        );
        requestAnimationFrame(() => {
          applyingLeftSplitRef.current = false;
        });
      }
      normalizeEditorGroupIds(dockviewApi);
      setLeftDockRevision((revision) => revision + 1);
    },
    [normalizeEditorGroupIds]
  );

  const placeLeftDockPanel = useCallback(
    (panelId: ActivityRailItemId, zone: LeftPanelDropZone) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      const title = ACTIVITY_RAIL_PANEL_TITLES[panelId];
      const existing = dockviewApi.getPanel(panelId);
      const others = ACTIVITY_RAIL_ITEMS.filter((id) => id !== panelId)
        .map((id) => dockviewApi.getPanel(id))
        .filter((panel): panel is NonNullable<typeof panel> => Boolean(panel));

      if (existing && others.length === 0) {
        const leftGroup = existing.group;
        if (leftGroup) {
          setColumnVisible(
            dockviewApi,
            getLayoutArrangement(),
            leftGroup,
            true
          );
        }
        finishLeftDockChange();
        return;
      }

      if (existing) {
        existing.api.moveTo({
          group: others[0].group,
          position: zone,
        });
        finishLeftDockChange(zone);
        return;
      }

      const leftGroup = ensureLeftDockGroup();
      if (!leftGroup) return;

      const reference = others[0];
      if (!reference) {
        dockviewApi.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { referenceGroup: leftGroup, direction: 'within' },
        });
      } else {
        dockviewApi.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: {
            referencePanel: reference,
            direction: dropZoneToDirection(zone),
          },
        });
      }

      setColumnVisible(dockviewApi, getLayoutArrangement(), leftGroup, true);
      finishLeftDockChange(others.length > 0 ? zone : undefined);
    },
    [ensureLeftDockGroup, finishLeftDockChange]
  );

  const measureLeftDock = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return null;
    return measureLeftDockBox(dockviewApi);
  }, []);

  const isLeftDockSplit = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return false;
    return readLeftDockSplit(dockviewApi);
  }, []);

  const unsplitLeftDock = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return;
    if (!unsplitLeftDockKeepLeading(dockviewApi)) return;
    finishLeftDockChange();
  }, [finishLeftDockChange]);

  const showOnlyLeftDockPanel = useCallback(
    (panelId: ActivityRailItemId) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      const title = ACTIVITY_RAIL_PANEL_TITLES[panelId];
      let existing = dockviewApi.getPanel(panelId);
      const leftGroup = ensureLeftDockGroup();
      if (!leftGroup) return;

      if (!existing) {
        dockviewApi.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { referenceGroup: leftGroup, direction: 'within' },
        });
        existing = dockviewApi.getPanel(panelId);
      }

      for (const otherId of ACTIVITY_RAIL_ITEMS) {
        if (otherId === panelId) continue;
        const other = dockviewApi.getPanel(otherId);
        if (other) dockviewApi.removePanel(other);
      }

      const panel = dockviewApi.getPanel(panelId);
      if (panel) {
        setColumnVisible(
          dockviewApi,
          getLayoutArrangement(),
          panel.group,
          true
        );
        panel.api.setActive();
      }
      finishLeftDockChange();
    },
    [ensureLeftDockGroup, finishLeftDockChange]
  );

  const toggleLeftDockPanel = useCallback(
    (panelId: ActivityRailItemId) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      const existing = dockviewApi.getPanel(panelId);
      const othersVisible = ACTIVITY_RAIL_ITEMS.some((id) => {
        if (id === panelId) return false;
        const panel = dockviewApi.getPanel(id);
        return Boolean(panel?.group.api.isVisible);
      });

      if (existing?.group.api.isVisible && !othersVisible) {
        setLeftDockVisible(dockviewApi, getLayoutArrangement(), false);
        finishLeftDockChange();
        return;
      }

      showOnlyLeftDockPanel(panelId);
    },
    [finishLeftDockChange, showOnlyLeftDockPanel]
  );

  const toggleFileTree = useCallback(() => {
    toggleLeftDockPanel(PANEL_IDS.FILE_TREE);
  }, [toggleLeftDockPanel]);

  const toggleGitPanel = useCallback(() => {
    toggleLeftDockPanel(PANEL_IDS.GIT);
  }, [toggleLeftDockPanel]);

  const toggleSearchPanel = useCallback(() => {
    toggleLeftDockPanel(PANEL_IDS.SEARCH);
  }, [toggleLeftDockPanel]);

  const toggleSessionList = useCallback(() => {
    toggleLeftDockPanel(PANEL_IDS.SESSION_LIST);
  }, [toggleLeftDockPanel]);

  const showFileTree = useCallback(() => {
    setFileTreeVisible(true);
    showOnlyLeftDockPanel(PANEL_IDS.FILE_TREE);
  }, [setFileTreeVisible, showOnlyLeftDockPanel]);

  const revealInFileTree = useCallback(
    (path: string, options?: RevealInFileTreeOptions) => {
      const nodeType = options?.nodeType ?? 'file';
      if (nodeType === 'file') {
        setSelectedFilePath(path);
      }
      revealInTree(path, nodeType);
      showFileTree();
    },
    [revealInTree, setSelectedFilePath, showFileTree]
  );

  const openOrFocusPanel = useCallback(
    (panelId: string, title: string) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      if (panelId === PANEL_IDS.TERMINAL) {
        openNewTerminal();
        return;
      }

      if (panelId === PANEL_IDS.FILE_TREE) {
        toggleFileTree();
        return;
      }

      if (panelId === PANEL_IDS.GIT) {
        toggleGitPanel();
        return;
      }

      if (panelId === PANEL_IDS.SEARCH) {
        toggleSearchPanel();
        return;
      }

      if (panelId === PANEL_IDS.SESSION_LIST) {
        toggleSessionList();
        return;
      }

      const existingPanel = dockviewApi.getPanel(panelId);
      if (existingPanel) {
        if (existingPanel.title !== title) {
          existingPanel.api.setTitle(title);
        }
        existingPanel.group.api.setVisible(true);
        existingPanel.api.setActive();
        return;
      }

      const panel = addPanelToActiveEditorGroup({
        id: panelId,
        component: panelId,
        title,
      });

      panel?.api.setActive();
    },
    [
      addPanelToActiveEditorGroup,
      openNewTerminal,
      toggleFileTree,
      toggleGitPanel,
      toggleSearchPanel,
      toggleSessionList,
    ]
  );

  const openMergePanel = useCallback(
    (params: { workspaceId: string; repoId: string; filePath: string }) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;
      const panelId = `merge:${params.filePath}`;
      const title = params.filePath.split(/[/\\]/).pop() || params.filePath;
      const existingPanel = dockviewApi.getPanel(panelId);
      if (existingPanel) {
        existingPanel.api.updateParameters(params);
        existingPanel.group.api.setVisible(true);
        existingPanel.api.setActive();
        return;
      }
      const panel = addPanelToActiveEditorGroup({
        id: panelId,
        component: PANEL_IDS.MERGE,
        title,
        params,
      });
      panel?.api.setActive();
    },
    [addPanelToActiveEditorGroup]
  );

  const openDiffPreview = useCallback(() => {
    clearCommitDiff();
    clearGitDiffTargetPath();
    openOrFocusPanel(PANEL_IDS.DIFFS, 'Diffs');
  }, [clearCommitDiff, clearGitDiffTargetPath, openOrFocusPanel]);

  const openDiffPreviewAtPath = useCallback(
    (path: string, options?: OpenFilePreviewOptions & { title?: string }) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      clearCommitDiff();
      clearGitDiffTargetPath();

      const panelId = buildDiffPreviewPanelId(path);
      const fileName = options?.title ?? (path.split(/[/\\]/).pop() || path);
      const params = buildPreviewPanelParams(path, {
        mode: 'diff',
        diffViewMode: options?.diffViewMode,
        modifiedContent: options?.modifiedContent,
        originalContent: options?.originalContent,
      });
      const existingPanel = dockviewApi.getPanel(panelId);

      if (existingPanel) {
        existingPanel.api.updateParameters(params);
        if (existingPanel.title !== fileName) {
          existingPanel.api.setTitle(fileName);
        }
        existingPanel.group.api.setVisible(true);
        existingPanel.api.setActive();
        markDiffPreviewPanelAsRecent(panelId);
        return;
      }

      const panel = addPanelToActiveEditorGroup({
        id: panelId,
        component: PANEL_IDS.PREVIEW,
        title: fileName,
        params,
      });

      if (!panel) return;

      panel.api.setActive();
      markDiffPreviewPanelAsRecent(panelId);
      enforceDiffPreviewPanelLimit(panelId);
    },
    [
      addPanelToActiveEditorGroup,
      clearCommitDiff,
      clearGitDiffTargetPath,
      enforceDiffPreviewPanelLimit,
      markDiffPreviewPanelAsRecent,
    ]
  );

  const openCommitDiff = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.DIFFS, 'Commit Diff');
  }, [openOrFocusPanel]);

  const isPanelOpen = useCallback((panelId: string) => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return false;

    const panel = dockviewApi.getPanel(panelId);
    if (!panel) return false;

    if (LEFT_PANEL_IDS.has(panelId)) {
      return panel.group.api.isVisible;
    }

    if (BOTTOM_PANEL_IDS.has(panelId)) {
      return panel.group.api.isVisible;
    }

    return true;
  }, []);

  const focusKanban = useCallback(() => {
    const dockviewApi = apiRef.current;
    const kanbanPanel = dockviewApi?.getPanel(PANEL_IDS.KANBAN);
    kanbanPanel?.api.setActive();
  }, []);

  const openLogs = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.LOGS, 'Logs');
  }, [openOrFocusPanel]);

  const openNotes = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.NOTES, 'Notes');
  }, [openOrFocusPanel]);

  const openPluginPanel = useCallback(
    (options: {
      panelId?: string;
      title: string;
      pluginId: string;
      contributionId: string;
      icon?: string | null;
      activate?: boolean;
      multiInstance?: boolean;
      instance?: 'new' | 'focus';
      requestedUrl?: string | null;
      nativeTabId?: string | null;
    }) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;
      const activate = options.activate !== false;
      const prefix = pluginSurfaceId(options.pluginId, options.contributionId);
      const mode =
        options.instance ?? (options.multiInstance ? 'new' : 'focus');
      let panelId = options.panelId;
      if (!panelId) {
        if (options.multiInstance && mode === 'new') {
          let next = 1;
          while (dockviewApi.getPanel(`${prefix}:${next}`)) next += 1;
          panelId = `${prefix}:${next}`;
        } else if (options.multiInstance && mode === 'focus') {
          const matches = dockviewApi.panels.filter(
            (panel) => panel.id === prefix || panel.id.startsWith(`${prefix}:`)
          );
          panelId = matches[matches.length - 1]?.id ?? `${prefix}:1`;
        } else {
          panelId = prefix;
        }
      }
      const params = {
        pluginId: options.pluginId,
        contributionId: options.contributionId,
        icon: options.icon ?? null,
        requestedUrl: options.requestedUrl ?? null,
        nativeTabId: options.nativeTabId ?? null,
      };
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.api.setTitle(options.title);
        existing.api.updateParameters(params);
        existing.group.api.setVisible(true);
        if (activate) existing.api.setActive();
        return;
      }
      let panel = addPanelToActiveEditorGroup({
        id: panelId,
        component: 'plugin-panel',
        title: options.title,
        params,
        inactive: !activate,
      });
      if (!panel) {
        try {
          panel = dockviewApi.addPanel({
            id: panelId,
            component: 'plugin-panel',
            title: options.title,
            params,
            renderer: 'onlyWhenVisible',
          });
        } catch (error) {
          console.error('[vibex-browser] failed to add browser tab', error);
        }
      }
      if (activate) panel?.api.setActive();
    },
    [addPanelToActiveEditorGroup]
  );
  openPluginPanelRef.current = openPluginPanel;

  const openWebPreview = useCallback(
    (url?: string | null) => {
      if (!canOpenWebPreview) return;
      const browserPanel = findHostBrowserContribution(pluginPanels);
      if (!browserPanel) return;
      const metadata = contributionMetadata(browserPanel);
      const icon = typeof metadata.icon === 'string' ? metadata.icon : null;
      openPluginPanel({
        title: browserPanel.label,
        pluginId: browserPanel.pluginId,
        contributionId: browserPanel.id,
        icon,
        multiInstance: true,
        instance: 'new',
        requestedUrl: url?.trim() || null,
      });
    },
    [canOpenWebPreview, openPluginPanel, pluginPanels]
  );

  useEffect(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return;
    const liveIds = new Set(
      pluginPanels.map((item) => pluginSurfaceId(item.pluginId, item.id))
    );
    for (const id of [...offeredPluginPanelsRef.current]) {
      if (!liveIds.has(id)) offeredPluginPanelsRef.current.delete(id);
    }
    for (const item of pluginPanels) {
      const metadata = contributionMetadata(item);
      if (metadata.multiInstance === true) continue;
      const panelId = pluginSurfaceId(item.pluginId, item.id);
      const existing = Boolean(dockviewApi.getPanel(panelId));
      const offered = offeredPluginPanelsRef.current.has(panelId);
      if (!shouldOpenContributedPanel(existing, offered)) {
        if (existing) offeredPluginPanelsRef.current.add(panelId);
        continue;
      }
      const icon = typeof metadata.icon === 'string' ? metadata.icon : null;
      offeredPluginPanelsRef.current.add(panelId);
      openPluginPanel({
        panelId,
        title: item.label,
        pluginId: item.pluginId,
        contributionId: item.id,
        icon,
        activate: false,
      });
    }
  }, [dockviewEpoch, openPluginPanel, pluginPanels]);

  useEffect(() => {
    if (!canOpenWebPreview) return undefined;
    const openFromEvent = (request: {
      url?: string | null;
      nativeTabId?: string | null;
    }) => {
      if (!apiRef.current || !openPluginPanelRef.current) {
        pendingBrowserOpensRef.current.push(request);
        return;
      }
      const nativeTabId = request.nativeTabId ?? null;
      if (nativeTabId) {
        const existing = apiRef.current.panels.find((panel) => {
          const params = panel.params as { nativeTabId?: string | null };
          return params?.nativeTabId === nativeTabId;
        });
        if (existing) {
          existing.group.api.setVisible(true);
          existing.api.setActive();
          return;
        }
      }
      const browser = findHostBrowserContribution(pluginPanelsRef.current);
      if (!browser) return;
      const metadata = contributionMetadata(browser);
      openPluginPanelRef.current({
        title: browser.label,
        pluginId: browser.pluginId,
        contributionId: browser.id,
        icon: typeof metadata.icon === 'string' ? metadata.icon : 'globe',
        multiInstance: true,
        instance: 'new',
        requestedUrl: request.url ?? null,
        nativeTabId: request.nativeTabId ?? null,
      });
    };
    setBrowserTabOpenHandler(openFromEvent);
    ensureBrowserTabOpenBridge();
    let disposed = false;
    let stop: (() => void) | undefined;
    void backendListen<{
      kind?: string;
      url?: string;
      tabId?: string;
      sourceTabId?: string;
      reason?: string;
      action?: string;
      outcome?: string;
      at?: number;
      requestId?: string;
      origin?: string | null;
      title?: string | null;
      code?: string;
      expiresAt?: number;
      state?: string;
      fileName?: string;
      path?: string | null;
    }>('plugin.browser', (payload) => {
      applyBrowserHostEvent(payload);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
      setBrowserTabOpenHandler(null);
    };
  }, [canOpenWebPreview]);

  useEffect(() => {
    const open = openPluginPanelRef.current;
    if (!apiRef.current || !open) return;
    const queued = pendingBrowserOpensRef.current.splice(0);
    if (queued.length === 0) return;
    const browser = findHostBrowserContribution(pluginPanels);
    if (!browser) return;
    const metadata = contributionMetadata(browser);
    for (const request of queued) {
      open({
        title: browser.label,
        pluginId: browser.pluginId,
        contributionId: browser.id,
        icon: typeof metadata.icon === 'string' ? metadata.icon : 'globe',
        multiInstance: true,
        instance: 'new',
        requestedUrl: request.url ?? null,
        nativeTabId: request.nativeTabId ?? null,
      });
    }
  }, [dockviewEpoch, pluginPanels]);

  const value = useMemo<PanelActions>(
    () => {
      void leftDockRevision;
      return {
      openOrFocusPanel,
      openFilePreview,
      openImagePreview,
      openWebPreview,
      revealInFileTree,
      openDiffPreview,
      openDiffPreviewAtPath,
      openMergePanel,
      openCommitDiff,
      openNewTerminal,
      openTerminalEditorTab,
      showTerminal,
      toggleEditorArea,
      openPanelInNewEditorGroup,
      canOpenPanelInNewEditorGroup,
      splitActiveEditor,
      canSplitActiveEditor,
      closePanel,
      toggleFileTree,
      showFileTree,
      toggleGitPanel,
      toggleSearchPanel,
      toggleSessionList,
      placeLeftDockPanel,
      measureLeftDock,
      isLeftDockSplit,
      unsplitLeftDock,
      isPanelOpen,
      focusKanban,
      openLogs,
      openNotes,
      openPluginPanel,
      setDockviewApi,
    };
    },
    [
      canOpenPanelInNewEditorGroup,
      canSplitActiveEditor,
      closePanel,
      focusKanban,
      isPanelOpen,
      openCommitDiff,
      openDiffPreview,
      openDiffPreviewAtPath,
      openMergePanel,
      openFilePreview,
      openImagePreview,
      openWebPreview,
      revealInFileTree,
      openLogs,
      openNewTerminal,
      openTerminalEditorTab,
      showTerminal,
      openNotes,
      openPluginPanel,
      openOrFocusPanel,
      openPanelInNewEditorGroup,
      setDockviewApi,
      splitActiveEditor,
      toggleEditorArea,
      toggleFileTree,
      showFileTree,
      toggleGitPanel,
      toggleSearchPanel,
      toggleSessionList,
      placeLeftDockPanel,
      measureLeftDock,
      isLeftDockSplit,
      unsplitLeftDock,
      leftDockRevision,
    ]
  );

  return (
    <PanelActionsContext.Provider value={value}>
      {children}
    </PanelActionsContext.Provider>
  );
}

export function usePanelActionsContext(): PanelActions {
  const context = useContext(PanelActionsContext);
  if (!context) {
    throw new Error(
      'usePanelActionsContext must be used within a PanelActionsProvider'
    );
  }

  return context;
}

export function useOptionalPanelActionsContext(): PanelActions | null {
  return useContext(PanelActionsContext);
}
