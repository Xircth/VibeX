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
import type { DockviewGroupPanel } from 'dockview-core';
import type { DockviewApi } from 'dockview-react';
import { useQueryClient } from '@tanstack/react-query';
import { fileContentKeys } from '@/hooks/useFileContent';
import {
  deriveRelativeFilePath,
  isAbsoluteFilePath,
  normalizeFilePath,
  replaceFilePathPrefix,
} from '@/utils/filePaths';
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
import { BROWSER_HOST_EVENT } from '@/features/host-browser/browserHostEvent';
import {
  ensureBrowserTabOpenBridge,
  setBrowserTabOpenHandler,
} from '@/features/host-browser/openBrowserTab';
import {
  clearTerminalShelf,
  markTerminalShelf,
  terminalShelfGroupId,
} from '@/lib/terminalShelf';
import {
  editorTerminalPanelId,
  isEditorTerminalPanelId,
  tabIdFromEditorTerminalPanelId,
} from '@/lib/workspaceTerminalTabs';
import {
  generateTerminalTabId,
  useTerminalStore,
} from '@/stores/useTerminalStore';
import {
  buildPreviewPanelParams,
  type PreviewPanelParams,
  type OpenFilePreviewOptions,
  type OpenFilePreviewResult,
} from '@/types/panels';
import { useGitDiffNavigationStore } from '@/stores/useGitDiffNavigationStore';
import {
  BOTTOM_PANEL_IDS,
  compareEditorGroups,
  getGroupElement,
  getNextEditorGroupId,
  isEditorGroup,
  isLeftGroup,
  isPlaceholderPanelId,
  isSessionGroup,
  isSplittableEditorPanel,
  LEFT_PANEL_IDS,
  listLeftDockGroups,
} from '@/utils/dockviewGroupPolicy';
import { getLayoutArrangement } from '@/lib/layoutArrangement';
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
  revealEditorColumnForTerminal,
  setColumnVisible,
  setLeftDockVisible,
} from '@/utils/dockviewEditorGroup';
import {
  clearImagePreviewSources,
  registerImagePreviewSource,
  releaseImagePreviewSource,
} from '@/lib/imagePreviewRegistry';
import {
  addGroupBelowEditorGroups,
  leastPopulatedEditorGroup,
  terminalShelfHeight,
  type EditorSplitDirection,
} from '@/utils/dockviewEditorSplit';
import {
  releaseLegacyTerminalZones,
  rememberTerminalShelfFromApi,
} from '@/utils/terminalZoneRelease';

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
  renameFilePreviews: (oldPath: string, newPath: string) => void;
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
  openTerminalEditorTab: (shell?: string) => void;
  showTerminal: () => void;
  toggleEditorArea: () => void;
  runInEditorGroup: (groupId: string, action: () => void) => void;
  splitEditorPanel: (
    panelId: string,
    direction: EditorSplitDirection
  ) => boolean;
  sortEditorGroupByName: (groupId: string) => void;
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

export const PanelActionsContext = createContext<PanelActions | null>(null);

export function PanelActionsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const apiRef = useRef<DockviewApi | null>(null);
  const [dockviewEpoch, setDockviewEpoch] = useState(0);
  const offeredPluginPanelsRef = useRef(new Set<string>());
  const pendingBrowserOpensRef = useRef<
    Array<{ url?: string | null; nativeTabId?: string | null }>
  >([]);
  const openPluginPanelRef = useRef<
    | ((options: {
        title: string;
        pluginId: string;
        contributionId: string;
        icon?: string | null;
        multiInstance?: boolean;
        instance?: 'new' | 'focus';
        requestedUrl?: string | null;
        nativeTabId?: string | null;
      }) => void)
    | null
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
  const preferredEditorGroupIdRef = useRef<string | null>(null);
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
    const removeGroupDisposable = api.onDidRemoveGroup((group) => {
      clearTerminalShelf(group.id);
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
    const layoutDisposable = api.onDidLayoutChange(() => {
      if (applyingLeftSplitRef.current) return;
      if (frame) return;
      frame = requestAnimationFrame(syncSplit);
    });
    layoutDisposableRef.current = {
      dispose: () => {
        layoutDisposable.dispose();
        removeGroupDisposable.dispose();
      },
    };
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

      releaseLegacyTerminalZones(dockviewApi);
      rememberTerminalShelfFromApi(dockviewApi);

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
    [getRightGroup]
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

  const runInEditorGroup = useCallback(
    (groupId: string, action: () => void) => {
      const previous = preferredEditorGroupIdRef.current;
      preferredEditorGroupIdRef.current = groupId;
      try {
        action();
      } finally {
        preferredEditorGroupIdRef.current = previous;
      }
    },
    []
  );

  const addPanelToActiveEditorGroup = useCallback(
    (options: AddPanelOptions, placement: 'active' | 'least' = 'least') => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return undefined;

      const preferredId = preferredEditorGroupIdRef.current;
      const preferred = preferredId
        ? dockviewApi.getGroup(preferredId)
        : undefined;
      let targetGroup =
        preferred && isEditorGroup(preferred) ? preferred : undefined;
      if (!targetGroup && placement === 'least') {
        const visible = getEditorGroups(dockviewApi).filter(
          (group) => group.api.isVisible
        );
        const activeId =
          dockviewApi.activeGroup && isEditorGroup(dockviewApi.activeGroup)
            ? dockviewApi.activeGroup.id
            : undefined;
        targetGroup = leastPopulatedEditorGroup(visible, activeId);
      }
      targetGroup ??= getActiveEditorGroup();
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
          referenceGroup: targetGroup.id,
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
    [
      getActiveEditorGroup,
      getEditorGroups,
      getLeftGroup,
      normalizeEditorGroupIds,
    ]
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

      const basePanelId = `file:${filePath}`;
      let panelId = basePanelId;
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      const title = options?.title ?? options?.displayPath ?? fileName;
      const params = buildPreviewPanelParams(filePath, options);

      const existingPanel = dockviewApi.panels.find(
        (panel) =>
          panel.view.contentComponent === PANEL_IDS.PREVIEW &&
          panel.params?.filePath === filePath
      );
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

      for (let suffix = 1; dockviewApi.getPanel(panelId); suffix += 1) {
        panelId = `${basePanelId}:${suffix}`;
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

  const renameFilePreviews = useCallback(
    (oldPath: string, newPath: string) => {
      const remap = (path: string) =>
        replaceFilePathPrefix(path, oldPath, newPath);
      for (const [key, data] of queryClient.getQueriesData({
        queryKey: fileContentKeys.all,
      })) {
        if (typeof key[1] !== 'string' || data === undefined) continue;
        const path = remap(key[1]);
        if (path !== key[1])
          queryClient.setQueryData(fileContentKeys.byPath(path), data);
      }
      for (const panel of apiRef.current?.panels ?? []) {
        if (panel.view.contentComponent !== PANEL_IDS.PREVIEW) continue;
        const params = panel.params as Partial<PreviewPanelParams>;
        if (!params.filePath) continue;
        const path = remap(params.filePath);
        if (path === params.filePath) continue;
        let displayPath = params.displayPath ?? null;
        if (displayPath) {
          if (isAbsoluteFilePath(displayPath)) {
            displayPath = remap(displayPath);
          } else {
            const originalPath = normalizeFilePath(params.filePath);
            const relativeDisplayPath = normalizeFilePath(displayPath);
            const displayRoot = originalPath.endsWith(`/${relativeDisplayPath}`)
              ? originalPath.slice(0, -(relativeDisplayPath.length + 1))
              : useFileTreeStore.getState().rootPath;
            displayPath =
              deriveRelativeFilePath(path, displayRoot) ?? displayPath;
          }
        }
        panel.api.updateParameters({
          ...params,
          filePath: path,
          renamedFrom: params.filePath,
          displayPath,
        });
        panel.api.setTitle(path.split(/[/\\]/).pop() ?? path);
      }
      useFileTreeStore.setState((state) => ({
        selectedFilePath: state.selectedFilePath
          ? remap(state.selectedFilePath)
          : null,
        diffFilePath: state.diffFilePath ? remap(state.diffFilePath) : null,
        revealTarget: state.revealTarget
          ? { ...state.revealTarget, path: remap(state.revealTarget.path) }
          : null,
      }));
    },
    [queryClient]
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

  const findTerminalShelf = useCallback((dockviewApi: DockviewApi) => {
    releaseLegacyTerminalZones(dockviewApi);
    rememberTerminalShelfFromApi(dockviewApi);
    const shelfId = terminalShelfGroupId();
    if (!shelfId) return undefined;
    const group = dockviewApi.getGroup(shelfId);
    if (!group || !isEditorGroup(group)) {
      clearTerminalShelf(shelfId);
      return undefined;
    }
    return group;
  }, []);

  const addShelfTerminal = useCallback(
    (
      dockviewApi: DockviewApi,
      group: NonNullable<ReturnType<DockviewApi['getGroup']>>,
      shell?: string
    ) => {
      const tabId = generateTerminalTabId();
      return dockviewApi.addPanel({
        id: editorTerminalPanelId(tabId),
        component: PANEL_IDS.TERMINAL,
        title: 'Terminal',
        renderer: 'onlyWhenVisible',
        params: {
          surface: 'editor',
          tabId,
          terminalShelf: true,
          ...(shell ? { shell } : {}),
        },
        position: { referenceGroup: group.id, direction: 'within' },
      });
    },
    []
  );

  const setTerminalVisibility = useCallback(
    (toggleExisting: boolean) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      const existing = findTerminalShelf(dockviewApi);
      if (existing) {
        const nextVisible = toggleExisting ? !existing.api.isVisible : true;
        existing.api.setVisible(nextVisible);
        markTerminalShelf(existing.id, nextVisible);
        if (!nextVisible) return;

        if (isEditorColumnCrushed(dockviewApi)) {
          const leftGroup = getLeftGroup(dockviewApi);
          restoreFlexibleEditorColumn(
            dockviewApi,
            getLayoutArrangement(),
            useLayoutStore.getState().rightPanelWidth,
            leftGroup?.api.isVisible ? leftGroup.api.width : undefined
          );
        }

        const terminal =
          existing.panels.find((panel) => isEditorTerminalPanelId(panel.id)) ??
          null;
        const panel = terminal ?? addShelfTerminal(dockviewApi, existing);
        panel.api.setActive();
        normalizeEditorGroupIds(dockviewApi);
        return;
      }

      const visibleEditors = getEditorGroups(dockviewApi).filter(
        (group) => group.api.isVisible
      );
      if (visibleEditors.length === 0) {
        const leftGroup = getLeftGroup(dockviewApi);
        const group = revealEditorColumnForTerminal(dockviewApi, {
          arrangement: getLayoutArrangement(),
          sessionWidth: useLayoutStore.getState().rightPanelWidth,
          dockWidth: leftGroup?.api.isVisible ? leftGroup.api.width : undefined,
        });
        if (!group) return;

        const tabId = generateTerminalTabId();
        const placeholders = group.panels.filter((panel) =>
          isPlaceholderPanelId(panel.id)
        );
        const panel = dockviewApi.addPanel({
          id: editorTerminalPanelId(tabId),
          component: PANEL_IDS.TERMINAL,
          title: 'Terminal',
          renderer: 'onlyWhenVisible',
          params: { surface: 'editor', tabId },
          position: { referenceGroup: group.id, direction: 'within' },
        });
        for (const placeholder of placeholders) {
          const current = dockviewApi.getPanel(placeholder.id);
          if (!current) continue;
          try {
            dockviewApi.removePanel(current);
          } catch {
            // Ignore placeholder cleanup while the column is appearing.
          }
        }
        panel.api.setActive();
        normalizeEditorGroupIds(dockviewApi);
        return;
      }

      if (!visibleEditors[0]?.panels[0]) return;

      const height = terminalShelfHeight(dockviewApi.height);
      let shelf: ReturnType<DockviewApi['addGroup']>;
      try {
        shelf = addGroupBelowEditorGroups(dockviewApi, visibleEditors, {
          id: getNextEditorGroupId(dockviewApi),
          height,
        });
      } catch {
        return;
      }

      shelf.api.setVisible(true);
      if (height > 0) {
        try {
          shelf.api.setSize({ height });
        } catch {
          // The initial split size still applies when setSize is early.
        }
      }
      markTerminalShelf(shelf.id, true);
      const panel = addShelfTerminal(dockviewApi, shelf);
      panel.api.setActive();
      normalizeEditorGroupIds(dockviewApi);
    },
    [
      addShelfTerminal,
      findTerminalShelf,
      getEditorGroups,
      getLeftGroup,
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

  const openTerminalEditorTab = useCallback(
    (shell?: string) => {
      const tabId = generateTerminalTabId();
      const panel = addPanelToActiveEditorGroup(
        {
          id: editorTerminalPanelId(tabId),
          component: PANEL_IDS.TERMINAL,
          title: 'Terminal',
          params: {
            surface: 'editor',
            tabId,
            ...(shell ? { shell } : {}),
          },
        },
        'active'
      );
      panel?.api.setActive();
    },
    [addPanelToActiveEditorGroup]
  );

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

  const splitEditorPanel = useCallback(
    (panelId: string, direction: EditorSplitDirection) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi || !canOpenPanelInNewEditorGroup(panelId)) {
        return false;
      }

      const panel = dockviewApi.getPanel(panelId);
      if (!panel) return false;

      const newGroup = dockviewApi.addGroup({
        id: getNextEditorGroupId(dockviewApi),
        referencePanel: panel,
        direction,
        skipSetActive: true,
      });

      const host = (
        dockviewApi as unknown as {
          component?: {
            moveGroupOrPanel: (options: {
              from: { groupId: string; panelId?: string };
              to: { group: typeof newGroup; position: 'center' };
              skipSetActive?: boolean;
              keepEmptyGroups?: boolean;
            }) => void;
          };
        }
      ).component;

      try {
        if (host?.moveGroupOrPanel) {
          host.moveGroupOrPanel({
            from: { groupId: panel.group.id, panelId: panel.id },
            to: { group: newGroup, position: 'center' },
            skipSetActive: true,
            keepEmptyGroups: true,
          });
        } else {
          panel.api.moveTo({ group: newGroup, skipSetActive: true });
        }
      } catch {
        try {
          dockviewApi.removeGroup(newGroup);
        } catch {
          // Ignore cleanup failures.
        }
        return false;
      }

      newGroup.api.setVisible(true);
      panel.api.setActive();
      normalizeEditorGroupIds(dockviewApi);
      return true;
    },
    [canOpenPanelInNewEditorGroup, normalizeEditorGroupIds]
  );

  const openPanelInNewEditorGroup = useCallback(
    (panelId: string) => splitEditorPanel(panelId, 'right'),
    [splitEditorPanel]
  );

  const sortEditorGroupByName = useCallback((groupId: string) => {
    const dockviewApi = apiRef.current;
    const group = dockviewApi?.getGroup(groupId);
    if (!group || !isEditorGroup(group)) return;

    const ordered = [...group.panels].sort((a, b) =>
      (a.title ?? a.id).localeCompare(b.title ?? b.id, undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    );
    ordered.forEach((panel, index) => {
      panel.api.moveTo({
        group: group as unknown as DockviewGroupPanel,
        index,
        skipSetActive: true,
      });
    });
  }, []);

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
          position: { referenceGroup: leftGroup.id, direction: 'within' },
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
          position: { referenceGroup: leftGroup.id, direction: 'within' },
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

    if (panelId === PANEL_IDS.TERMINAL) {
      const shelfId = terminalShelfGroupId();
      const shelf = shelfId ? dockviewApi.getGroup(shelfId) : undefined;
      return Boolean(shelf && isEditorGroup(shelf) && shelf.api.isVisible);
    }

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
    }>(BROWSER_HOST_EVENT, (payload) => {
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

  const value = useMemo<PanelActions>(() => {
    return {
      openOrFocusPanel,
      openFilePreview,
      renameFilePreviews,
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
      runInEditorGroup,
      splitEditorPanel,
      sortEditorGroupByName,
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
  }, [
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
    renameFilePreviews,
    openImagePreview,
    openWebPreview,
    revealInFileTree,
    openLogs,
    openNewTerminal,
    openTerminalEditorTab,
    showTerminal,
    runInEditorGroup,
    splitEditorPanel,
    sortEditorGroupByName,
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
  ]);

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
