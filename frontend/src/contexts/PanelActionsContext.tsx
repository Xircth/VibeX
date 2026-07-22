import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
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
import { DEFAULT_TERMINAL_PANEL_HEIGHT } from '@/lib/terminalPreferences';
import {
  buildPreviewPanelParams,
  type OpenFilePreviewOptions,
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
  SESSION_PANEL_IDS,
} from '@/utils/dockviewGroupPolicy';
import { getLayoutArrangement, slotOfZone } from '@/lib/layoutArrangement';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { MIN_LEFT_PANEL_WIDTH } from '@/utils/dockviewWorkspaceConstraints';

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

export interface PanelActions {
  openOrFocusPanel: (panelId: string, title: string) => void;
  openFilePreview: (filePath: string, options?: OpenFilePreviewOptions) => void;
  openImagePreview: (
    imageUrl: string,
    options?: { title?: string | null }
  ) => void;
  openWebPreview: (url: string) => void;
  revealInFileTree: (path: string, options?: RevealInFileTreeOptions) => void;
  openDiffPreview: () => void;
  openDiffPreviewAtPath: (
    path: string,
    options?: OpenFilePreviewOptions & { title?: string }
  ) => void;
  openCommitDiff: () => void;
  openNewTerminal: () => void;
  toggleEditorArea: () => void;
  openPanelInNewEditorGroup: (panelId: string) => boolean;
  canOpenPanelInNewEditorGroup: (panelId: string) => boolean;
  splitActiveEditor: () => boolean;
  canSplitActiveEditor: () => boolean;
  closePanel: (panelId: string) => void;
  toggleFileTree: () => void;
  toggleGitPanel: () => void;
  toggleSearchPanel: () => void;
  toggleSessionList: () => void;
  isPanelOpen: (panelId: string) => boolean;
  focusKanban: () => void;
  openLogs: () => void;
  openNotes: () => void;
  setDockviewApi: (api: DockviewApi | null) => void;
}

const PanelActionsContext = createContext<PanelActions | null>(null);

export function PanelActionsProvider({ children }: { children: ReactNode }) {
  const apiRef = useRef<DockviewApi | null>(null);
  const diffPreviewPanelQueueRef = useRef<string[]>([]);
  const webPreviewRequestNonceRef = useRef(0);
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

  const setDockviewApi = useCallback((api: DockviewApi | null) => {
    apiRef.current = api;
    if (!api) {
      diffPreviewPanelQueueRef.current = [];
    }
  }, []);

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
      const leftGroup = getLeftGroup(dockviewApi);
      if (leftGroup) {
        (leftGroup as { id: string }).id = GROUP_IDS.LEFT;
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
    [getBottomGroup, getLeftGroup, getRightGroup]
  );

  const ensureWelcomeEditorGroup = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return undefined;

    const existingEditorGroups = getEditorGroups(dockviewApi);
    if (existingEditorGroups.length > 0) {
      normalizeEditorGroupIds(dockviewApi);
      return existingEditorGroups[0];
    }

    const existingWelcome = dockviewApi.getPanel(PANEL_IDS.WELCOME);
    if (existingWelcome) {
      normalizeEditorGroupIds(dockviewApi);
      return existingWelcome.group;
    }

    const bottomGroup = getBottomGroup(dockviewApi);
    const bottomReferencePanel = bottomGroup?.panels[0];
    const leftGroup = getLeftGroup(dockviewApi);
    const referencePanel =
      bottomReferencePanel ??
      leftGroup?.panels[0] ??
      dockviewApi.panels.find(
        (panel) =>
          !BOTTOM_PANEL_IDS.has(panel.id) && !SESSION_PANEL_IDS.has(panel.id)
      );

    const welcomePanel = dockviewApi.addPanel({
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

    (welcomePanel.group as { id: string }).id =
      getNextEditorGroupId(dockviewApi);
    normalizeEditorGroupIds(dockviewApi);
    return welcomePanel.group;
  }, [getBottomGroup, getEditorGroups, getLeftGroup, normalizeEditorGroupIds]);

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

    return getEditorGroups(dockviewApi)[0] ?? ensureWelcomeEditorGroup();
  }, [ensureWelcomeEditorGroup, getEditorGroups]);

  const addPanelToActiveEditorGroup = useCallback(
    (options: AddPanelOptions) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return undefined;

      const targetGroup = getActiveEditorGroup();
      if (!targetGroup) return undefined;

      targetGroup.api.setVisible(true);

      const placeholderPanels = targetGroup.panels.filter((panel) =>
        isPlaceholderPanelId(panel.id)
      );

      const panel = dockviewApi.addPanel({
        ...options,
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
    [getActiveEditorGroup, normalizeEditorGroupIds]
  );

  const openFilePreview = useCallback(
    (filePath: string, options?: OpenFilePreviewOptions) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      setSelectedFilePath(filePath);
      revealInTree(filePath, 'file');

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
    [addPanelToActiveEditorGroup, revealInTree, setSelectedFilePath]
  );

  const openImagePreview = useCallback(
    (imageUrl: string, options?: { title?: string | null }) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      const panelId = buildImagePreviewPanelId(imageUrl);
      const title = options?.title?.trim() || 'Image';
      const params = {
        filePath: '',
        mode: 'editor',
        diffViewMode: 'split',
        modifiedContent: null,
        originalContent: null,
        displayPath: options?.title ?? null,
        location: null,
        imageUrl,
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

  const openWebPreview = useCallback(
    (url: string) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      webPreviewRequestNonceRef.current += 1;
      const params = {
        requestedUrl: url,
        requestedUrlNonce: webPreviewRequestNonceRef.current,
      };

      const existingPanel = dockviewApi.getPanel(PANEL_IDS.WEB_PREVIEW);
      if (existingPanel) {
        existingPanel.api.updateParameters(params);
        existingPanel.group.api.setVisible(true);
        existingPanel.api.setActive();
        return;
      }

      const panel = addPanelToActiveEditorGroup({
        id: PANEL_IDS.WEB_PREVIEW,
        component: PANEL_IDS.WEB_PREVIEW,
        title: 'Web Preview',
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

  const openNewTerminal = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return;

    const existingTerminal = dockviewApi.getPanel(PANEL_IDS.TERMINAL);
    let bottomGroup = getBottomGroup(dockviewApi);

    if (existingTerminal && bottomGroup) {
      const nextVisible = !bottomGroup.api.isVisible;
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
        position: { referenceGroup: GROUP_IDS.BOTTOM, direction: 'within' },
      });
      terminalPanel.api.setActive();
      applyDefaultTerminalHeight(bottomGroup);
      normalizeEditorGroupIds(dockviewApi);
      return;
    }

    if (existingTerminal && !bottomGroup) {
      // The terminal panel exists but its group wasn't recognized (e.g. a
      // transient state during a layout transform): toggle its own group
      // instead of re-adding a duplicate panel, which would throw.
      const group = existingTerminal.group;
      const nextVisible = !group.api.isVisible;
      group.api.setVisible(nextVisible);
      if (nextVisible) {
        existingTerminal.api.setActive();
      }
      return;
    }

    const targetGroup =
      getEditorGroups(dockviewApi)[0] ?? ensureWelcomeEditorGroup();
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
      position: { referenceGroup: GROUP_IDS.BOTTOM, direction: 'within' },
    });
    terminalPanel.api.setActive();
    applyDefaultTerminalHeight(bottomGroup);

    normalizeEditorGroupIds(dockviewApi);
  }, [
    applyDefaultTerminalHeight,
    ensureWelcomeEditorGroup,
    getBottomGroup,
    getEditorGroups,
    normalizeEditorGroupIds,
  ]);

  const toggleEditorArea = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return;

    const editorGroups = getEditorGroups(dockviewApi);
    if (editorGroups.length === 0) {
      const welcomeGroup = ensureWelcomeEditorGroup();
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
      const welcomeGroup = ensureWelcomeEditorGroup();
      welcomeGroup?.api.setVisible(true);
      dockviewApi.getPanel(PANEL_IDS.WELCOME)?.api.setActive();
    }

    normalizeEditorGroupIds(dockviewApi);
  }, [ensureWelcomeEditorGroup, getEditorGroups, normalizeEditorGroupIds]);

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

  const switchLeftPanel = useCallback(
    (
      targetId: string,
      targetComponent: string,
      targetTitle: string,
      otherPanelIds: string[]
    ) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      const existing = dockviewApi.getPanel(targetId);
      if (existing) {
        const leftGroup = getLeftGroup(dockviewApi);
        if (leftGroup) {
          const hasOtherLeftPanels = otherPanelIds.some(
            (panelId) => !!dockviewApi.getPanel(panelId)
          );

          if (hasOtherLeftPanels) {
            existing.api.setActive();

            for (const otherPanelId of otherPanelIds) {
              const otherPanel = dockviewApi.getPanel(otherPanelId);
              if (otherPanel) {
                dockviewApi.removePanel(otherPanel);
              }
            }

            leftGroup.api.setVisible(true);
            applyLeftGroupHeaderHiding(dockviewApi);
          } else {
            leftGroup.api.setVisible(!leftGroup.api.isVisible);
          }
        }

        return;
      }

      const existingLeftGroup = getLeftGroup(dockviewApi);
      const savedLeftWidth = existingLeftGroup?.api.isVisible
        ? existingLeftGroup.api.width
        : 0;

      let leftGroup = existingLeftGroup ?? null;
      if (!leftGroup) {
        const editorHost = ensureWelcomeEditorGroup();
        const referencePanel = editorHost?.panels[0];
        if (!referencePanel) return;

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

      dockviewApi.addPanel({
        id: targetId,
        component: targetComponent,
        title: targetTitle,
        position: { referenceGroup: GROUP_IDS.LEFT, direction: 'within' },
      });

      for (const otherPanelId of otherPanelIds) {
        const otherPanel = dockviewApi.getPanel(otherPanelId);
        if (otherPanel) {
          dockviewApi.removePanel(otherPanel);
        }
      }

      leftGroup.api.setVisible(true);
      applyLeftGroupHeaderHiding(dockviewApi);
      normalizeEditorGroupIds(dockviewApi);
    },
    [ensureWelcomeEditorGroup, getLeftGroup, normalizeEditorGroupIds]
  );

  const showLeftPanel = useCallback(
    (
      targetId: string,
      targetComponent: string,
      targetTitle: string,
      otherPanelIds: string[]
    ) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      const existing = dockviewApi.getPanel(targetId);
      if (existing) {
        existing.api.setActive();

        for (const otherPanelId of otherPanelIds) {
          const otherPanel = dockviewApi.getPanel(otherPanelId);
          if (otherPanel) {
            dockviewApi.removePanel(otherPanel);
          }
        }

        const leftGroup = getLeftGroup(dockviewApi);
        leftGroup?.api.setVisible(true);
        applyLeftGroupHeaderHiding(dockviewApi);
        normalizeEditorGroupIds(dockviewApi);
        return;
      }

      const existingLeftGroup = getLeftGroup(dockviewApi);
      const savedLeftWidth = existingLeftGroup?.api.isVisible
        ? existingLeftGroup.api.width
        : 0;

      let leftGroup = existingLeftGroup ?? null;
      if (!leftGroup) {
        const editorHost = ensureWelcomeEditorGroup();
        const referencePanel = editorHost?.panels[0];
        if (!referencePanel) return;

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

      dockviewApi.addPanel({
        id: targetId,
        component: targetComponent,
        title: targetTitle,
        position: { referenceGroup: GROUP_IDS.LEFT, direction: 'within' },
      });

      for (const otherPanelId of otherPanelIds) {
        const otherPanel = dockviewApi.getPanel(otherPanelId);
        if (otherPanel) {
          dockviewApi.removePanel(otherPanel);
        }
      }

      leftGroup.api.setVisible(true);
      applyLeftGroupHeaderHiding(dockviewApi);
      normalizeEditorGroupIds(dockviewApi);
    },
    [ensureWelcomeEditorGroup, getLeftGroup, normalizeEditorGroupIds]
  );

  const toggleFileTree = useCallback(() => {
    switchLeftPanel(PANEL_IDS.FILE_TREE, PANEL_IDS.FILE_TREE, 'Files', [
      PANEL_IDS.GIT,
      PANEL_IDS.SEARCH,
      PANEL_IDS.SESSION_LIST,
    ]);
  }, [switchLeftPanel]);

  const toggleGitPanel = useCallback(() => {
    switchLeftPanel(PANEL_IDS.GIT, PANEL_IDS.GIT, 'Git', [
      PANEL_IDS.FILE_TREE,
      PANEL_IDS.SEARCH,
      PANEL_IDS.SESSION_LIST,
    ]);
  }, [switchLeftPanel]);

  const toggleSearchPanel = useCallback(() => {
    switchLeftPanel(PANEL_IDS.SEARCH, PANEL_IDS.SEARCH, 'Search', [
      PANEL_IDS.FILE_TREE,
      PANEL_IDS.GIT,
      PANEL_IDS.SESSION_LIST,
    ]);
  }, [switchLeftPanel]);

  const toggleSessionList = useCallback(() => {
    switchLeftPanel(
      PANEL_IDS.SESSION_LIST,
      PANEL_IDS.SESSION_LIST,
      'Sessions',
      [PANEL_IDS.FILE_TREE, PANEL_IDS.GIT, PANEL_IDS.SEARCH]
    );
  }, [switchLeftPanel]);

  const showFileTree = useCallback(() => {
    setFileTreeVisible(true);
    showLeftPanel(PANEL_IDS.FILE_TREE, PANEL_IDS.FILE_TREE, 'Files', [
      PANEL_IDS.GIT,
      PANEL_IDS.SEARCH,
      PANEL_IDS.SESSION_LIST,
    ]);
  }, [setFileTreeVisible, showLeftPanel]);

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
      return panel.group.api.isVisible && panel.api.isActive;
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

  const value = useMemo<PanelActions>(
    () => ({
      openOrFocusPanel,
      openFilePreview,
      openImagePreview,
      openWebPreview,
      revealInFileTree,
      openDiffPreview,
      openDiffPreviewAtPath,
      openCommitDiff,
      openNewTerminal,
      toggleEditorArea,
      openPanelInNewEditorGroup,
      canOpenPanelInNewEditorGroup,
      splitActiveEditor,
      canSplitActiveEditor,
      closePanel,
      toggleFileTree,
      toggleGitPanel,
      toggleSearchPanel,
      toggleSessionList,
      isPanelOpen,
      focusKanban,
      openLogs,
      openNotes,
      setDockviewApi,
    }),
    [
      canOpenPanelInNewEditorGroup,
      canSplitActiveEditor,
      closePanel,
      focusKanban,
      isPanelOpen,
      openCommitDiff,
      openDiffPreview,
      openDiffPreviewAtPath,
      openFilePreview,
      openImagePreview,
      openWebPreview,
      revealInFileTree,
      openLogs,
      openNewTerminal,
      openNotes,
      openOrFocusPanel,
      openPanelInNewEditorGroup,
      setDockviewApi,
      splitActiveEditor,
      toggleEditorArea,
      toggleFileTree,
      toggleGitPanel,
      toggleSearchPanel,
      toggleSessionList,
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
