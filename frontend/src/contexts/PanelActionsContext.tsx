import {
  createContext,
  useContext,
  useCallback,
  useState,
  type ReactNode,
} from 'react';
import type { DockviewApi } from 'dockview-react';
import { PANEL_IDS, GROUP_IDS } from '@/stores/useLayoutStore';
import { applyLeftGroupHeaderHiding } from '@/utils/dockviewHelpers';
import { DEFAULT_TERMINAL_PANEL_HEIGHT } from '@/lib/terminalPreferences';

/**
 * IDs of panels that live in the left sidebar (no tab header).
 */
const LEFT_PANEL_IDS: ReadonlySet<string> = new Set([
  PANEL_IDS.FILE_TREE,
  PANEL_IDS.GIT,
  PANEL_IDS.SEARCH,
]);

/**
 * IDs of panels that live at the bottom.
 */
const BOTTOM_PANEL_IDS: ReadonlySet<string> = new Set([PANEL_IDS.TERMINAL]);

function isWelcomePlaceholderPanel(panelId: string): boolean {
  return panelId === PANEL_IDS.WELCOME || panelId === `${PANEL_IDS.WELCOME}-2`;
}

function countContentPanels(group: { panels: Array<{ id: string }> }): number {
  return group.panels.filter((panel) => !isWelcomePlaceholderPanel(panel.id)).length;
}

/**
 * PanelActions exposes methods to control dockview panels
 * from anywhere in the component tree.
 */
export interface PanelActions {
  /** Open or focus a panel by ID */
  openOrFocusPanel: (panelId: string, title: string) => void;
  /** Open a file preview panel for a specific file path */
  openFilePreview: (filePath: string) => void;
  /** Open the diff preview panel (or focus if already open) */
  openDiffPreview: () => void;
  /** Open a new terminal panel */
  openNewTerminal: () => void;
  /** Close a specific panel by ID */
  closePanel: (panelId: string) => void;
  /** Toggle the file tree sidebar */
  toggleFileTree: () => void;
  /** Toggle the git manager panel */
  toggleGitPanel: () => void;
  /** Toggle the search panel in the left sidebar */
  toggleSearchPanel: () => void;
  /** Check if a panel exists */
  isPanelOpen: (panelId: string) => boolean;
  /** Focus the kanban panel */
  focusKanban: () => void;
  /** Open the logs panel (or focus if already open) */
  openLogs: () => void;
  /** Open the notes panel (or focus if already open) */
  openNotes: () => void;
  /** Toggle visibility of the center-1 group (first center column) */
  toggleCenter1Visibility: () => void;
  /** Toggle visibility of the center-2 group (second center column) */
  toggleCenter2Visibility: () => void;
  /** Check if center-1 group is visible */
  isCenter1Visible: () => boolean;
  /** Check if center-2 group is visible */
  isCenter2Visible: () => boolean;
  /** Set the dockview API reference (internal use) */
  setDockviewApi: (api: DockviewApi | null) => void;
}

const PanelActionsContext = createContext<PanelActions | null>(null);

export function PanelActionsProvider({ children }: { children: ReactNode }) {
  const [dockviewApi, setDockviewApiState] = useState<DockviewApi | null>(null);

  const setDockviewApi = useCallback((api: DockviewApi | null) => {
    setDockviewApiState(api);
  }, []);

  const getCenter1Group = useCallback(() => {
    if (!dockviewApi) return undefined;
    return (
      dockviewApi.getGroup(GROUP_IDS.CENTER_1) ??
      dockviewApi.getPanel(PANEL_IDS.WELCOME)?.group
    );
  }, [dockviewApi]);

  const ensureCenter2Group = useCallback(() => {
    if (!dockviewApi) return undefined;

    const existingCenter2 =
      dockviewApi.getGroup(GROUP_IDS.CENTER_2) ??
      dockviewApi.getPanel(`${PANEL_IDS.WELCOME}-2`)?.group;
    if (existingCenter2) {
      return existingCenter2;
    }

    const referencePanel =
      dockviewApi.getPanel(PANEL_IDS.WELCOME) ?? dockviewApi.panels[0];
    if (!referencePanel) return undefined;

    const center2Group = dockviewApi.addGroup({
      id: GROUP_IDS.CENTER_2,
      referencePanel,
      direction: 'right',
    });

    if (!dockviewApi.getPanel(`${PANEL_IDS.WELCOME}-2`)) {
      dockviewApi.addPanel({
        id: `${PANEL_IDS.WELCOME}-2`,
        component: PANEL_IDS.WELCOME,
        title: 'Preview',
        position: {
          referenceGroup: GROUP_IDS.CENTER_2,
          direction: 'within',
        },
        inactive: true,
      });
    }

    return center2Group;
  }, [dockviewApi]);

  const chooseCenterGroupForNewPanel = useCallback(() => {
    if (!dockviewApi) return undefined;

    const center1Group = getCenter1Group();
    const center2Group = ensureCenter2Group();
    const orderedGroups = [center1Group, center2Group].filter(
      (
        group
      ): group is NonNullable<typeof center1Group> | NonNullable<typeof center2Group> =>
        Boolean(group)
    );

    if (orderedGroups.length === 0) {
      return undefined;
    }

    const candidateGroups = orderedGroups;

    const emptyCenter1 = candidateGroups.find(
      (group) => group.id === GROUP_IDS.CENTER_1 && countContentPanels(group) === 0
    );
    if (emptyCenter1) {
      return emptyCenter1;
    }

    const emptyCenter2 = candidateGroups.find(
      (group) => group.id === GROUP_IDS.CENTER_2 && countContentPanels(group) === 0
    );
    if (emptyCenter2) {
      return emptyCenter2;
    }

    return candidateGroups.reduce((bestGroup, group) => {
      const currentCount = countContentPanels(group);
      const bestCount = countContentPanels(bestGroup);

      if (currentCount !== bestCount) {
        return currentCount < bestCount ? group : bestGroup;
      }

      return group.id === GROUP_IDS.CENTER_1 ? group : bestGroup;
    });
  }, [dockviewApi, ensureCenter2Group, getCenter1Group]);

  /**
   * Find the best center group for a new tab panel.
   *
   * Priority:
   * 1. An empty center group (no panels)
   * 2. A center group that does NOT contain the kanban panel
   * 3. Fallback: add into first center group or create standalone
   */
  const openOrFocusPanel = useCallback(
    (panelId: string, title: string) => {
      if (!dockviewApi) return;

      // 1. Already exists → activate
      const existingPanel = dockviewApi.getPanel(panelId);
      if (existingPanel) {
        existingPanel.group.api.setVisible(true);
        existingPanel.api.setActive();
        return;
      }

      const targetGroup = chooseCenterGroupForNewPanel();
      if (targetGroup) {
        targetGroup.api.setVisible(true);
        dockviewApi.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: {
            referenceGroup: targetGroup.id,
            direction: 'within',
          },
        });
        return;
      }

      // 4. Fallback: standalone panel
      dockviewApi.addPanel({
        id: panelId,
        component: panelId,
        title,
      });
    },
    [dockviewApi]
  );

  const openFilePreview = useCallback(
    (filePath: string) => {
      if (!dockviewApi) return;

      // Generate a stable panel ID from file path
      const panelId = `file:${filePath}`;
      const fileName = filePath.split(/[/\\]/).pop() || filePath;

      // If panel for this file already exists, just activate it
      const existing = dockviewApi.getPanel(panelId);
      if (existing) {
        existing.group.api.setVisible(true);
        existing.api.setActive();
        return;
      }

      const targetGroup = chooseCenterGroupForNewPanel();

      if (targetGroup) {
        targetGroup.api.setVisible(true);
        dockviewApi.addPanel({
          id: panelId,
          component: PANEL_IDS.PREVIEW,
          title: fileName,
          params: { filePath },
          position: {
            referenceGroup: targetGroup.id,
            direction: 'within',
          },
        });
      } else {
        dockviewApi.addPanel({
          id: panelId,
          component: PANEL_IDS.PREVIEW,
          title: fileName,
          params: { filePath },
        });
      }
    },
    [chooseCenterGroupForNewPanel, dockviewApi]
  );

  const openDiffPreview = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.DIFFS, 'Diffs');
  }, [openOrFocusPanel]);

  const openNewTerminal = useCallback(() => {
    if (!dockviewApi) return;

    const existingTerminal = dockviewApi.getPanel(PANEL_IDS.TERMINAL);
    let bottomGroup = dockviewApi.getGroup(GROUP_IDS.BOTTOM);

    if (existingTerminal && bottomGroup) {
      bottomGroup.api.setVisible(!bottomGroup.api.isVisible);
      return;
    }

    if (!bottomGroup) {
      const centerGroups = dockviewApi.groups.filter((g) => {
        const ids = g.panels.map((p) => p.id);
        const isLeft = ids.some((id) => LEFT_PANEL_IDS.has(id));
        const isBottom = ids.some((id) => BOTTOM_PANEL_IDS.has(id));
        return !isLeft && !isBottom;
      });
      const refPanel = centerGroups[0]?.panels[0];
      if (!refPanel) return;

      bottomGroup = dockviewApi.addGroup({
        id: GROUP_IDS.BOTTOM,
        referencePanel: refPanel,
        direction: 'below',
        locked: 'no-drop-target',
        initialHeight: DEFAULT_TERMINAL_PANEL_HEIGHT,
      });
    }

    bottomGroup.locked = 'no-drop-target';
    dockviewApi.addPanel({
      id: PANEL_IDS.TERMINAL,
      component: PANEL_IDS.TERMINAL,
      title: 'Terminal',
      position: {
        referenceGroup: GROUP_IDS.BOTTOM,
        direction: 'within',
      },
      inactive: true,
    });
  }, [dockviewApi]);

  const closePanel = useCallback(
    (panelId: string) => {
      if (!dockviewApi) return;
      const panel = dockviewApi.getPanel(panelId);
      if (panel) {
        dockviewApi.removePanel(panel);
      }
    },
    [dockviewApi]
  );

  const toggleFileTree = useCallback(() => {
    if (!dockviewApi) return;

    // If file tree panel already exists, toggle it off (close the left group)
    const existing = dockviewApi.getPanel(PANEL_IDS.FILE_TREE);
    if (existing) {
      const leftGroup =
        dockviewApi.getGroup(GROUP_IDS.LEFT) ??
        dockviewApi.groups.find((g) => g.panels.some((p) => p.id === PANEL_IDS.FILE_TREE));
      leftGroup?.api.setVisible(false);
      return;
    }

    // Close git panel first (mutual exclusion)
    const gitPanel = dockviewApi.getPanel(PANEL_IDS.GIT);
    if (gitPanel) {
      dockviewApi.removePanel(gitPanel);
    }

    const leftGroup =
      dockviewApi.getGroup(GROUP_IDS.LEFT) ??
      dockviewApi.groups.find((group) =>
        group.panels.some(
          (panel) => panel.id === PANEL_IDS.FILE_TREE || panel.id === PANEL_IDS.GIT
        )
      );

    // Find existing left group by ID
    let resolvedLeftGroup = leftGroup;

    if (!resolvedLeftGroup) {
      // Create new left group
      const centerRef = dockviewApi.panels.find(
        (p) => !LEFT_PANEL_IDS.has(p.id) && !BOTTOM_PANEL_IDS.has(p.id)
      );
      if (!centerRef) return;
      resolvedLeftGroup = dockviewApi.addGroup({
        id: GROUP_IDS.LEFT,
        referencePanel: centerRef,
        direction: 'left',
        hideHeader: true,
        initialWidth: 300,
      });
    }

    dockviewApi.addPanel({
      id: PANEL_IDS.FILE_TREE,
      component: PANEL_IDS.FILE_TREE,
      title: '文件管理器',
      position: { referenceGroup: resolvedLeftGroup.id, direction: 'within' },
    });
    resolvedLeftGroup.api.setVisible(true);
    applyLeftGroupHeaderHiding(dockviewApi);
  }, [dockviewApi]);

  const toggleGitPanel = useCallback(() => {
    if (!dockviewApi) return;

    // If git panel already open, close it (toggle off)
    const existing = dockviewApi.getPanel(PANEL_IDS.GIT);
    if (existing) {
      dockviewApi.removePanel(existing);
      return;
    }

    // Close file tree panel first (mutual exclusion)
    const fileTreePanel = dockviewApi.getPanel(PANEL_IDS.FILE_TREE);
    if (fileTreePanel) {
      dockviewApi.removePanel(fileTreePanel);
    }

    // Find existing left group by ID
    let leftGroup = dockviewApi.groups.find((g) => g.id === GROUP_IDS.LEFT);

    if (!leftGroup) {
      // Create new left group
      const centerRef = dockviewApi.panels.find(
        (p) => !LEFT_PANEL_IDS.has(p.id) && !BOTTOM_PANEL_IDS.has(p.id)
      );
      if (!centerRef) return;
      leftGroup = dockviewApi.addGroup({
        id: GROUP_IDS.LEFT,
        referencePanel: centerRef,
        direction: 'left',
        hideHeader: true,
        initialWidth: 300,
      });
    }

    dockviewApi.addPanel({
      id: PANEL_IDS.GIT,
      component: PANEL_IDS.GIT,
      title: 'Git 管理器',
      position: { referenceGroup: leftGroup, direction: 'within' },
    });
    applyLeftGroupHeaderHiding(dockviewApi);
  }, [dockviewApi]);

  const toggleSearchPanel = useCallback(() => {
    if (!dockviewApi) return;

    const existing = dockviewApi.getPanel(PANEL_IDS.SEARCH);
    if (existing) {
      dockviewApi.removePanel(existing);
      return;
    }

    // Close other left panels (mutual exclusion)
    const fileTreePanel = dockviewApi.getPanel(PANEL_IDS.FILE_TREE);
    if (fileTreePanel) {
      dockviewApi.removePanel(fileTreePanel);
    }
    const gitPanel = dockviewApi.getPanel(PANEL_IDS.GIT);
    if (gitPanel) {
      dockviewApi.removePanel(gitPanel);
    }

    let leftGroup = dockviewApi.groups.find((g) => g.id === GROUP_IDS.LEFT);

    if (!leftGroup) {
      const centerRef = dockviewApi.panels.find(
        (p) => !LEFT_PANEL_IDS.has(p.id) && !BOTTOM_PANEL_IDS.has(p.id)
      );
      if (!centerRef) return;
      leftGroup = dockviewApi.addGroup({
        id: GROUP_IDS.LEFT,
        referencePanel: centerRef,
        direction: 'left',
        hideHeader: true,
        initialWidth: 300,
      });
    }

    dockviewApi.addPanel({
      id: PANEL_IDS.SEARCH,
      component: PANEL_IDS.SEARCH,
      title: '搜索',
      position: { referenceGroup: leftGroup, direction: 'within' },
    });
    applyLeftGroupHeaderHiding(dockviewApi);
  }, [dockviewApi]);

  const isPanelOpen = useCallback(
    (panelId: string) => {
      if (!dockviewApi) return false;
      return !!dockviewApi.getPanel(panelId);
    },
    [dockviewApi]
  );

  const openLogs = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.LOGS, 'Logs');
  }, [openOrFocusPanel]);

  const openNotes = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.NOTES, '笔记');
  }, [openOrFocusPanel]);

  const focusKanban = useCallback(() => {
    if (!dockviewApi) return;
    const kanbanPanel = dockviewApi.getPanel(PANEL_IDS.KANBAN);
    if (kanbanPanel) {
      kanbanPanel.api.setActive();
    }
  }, [dockviewApi]);

  /**
   * Get center groups ordered by their position in the groups array.
   * Center groups are those that are neither left-sidebar nor bottom groups.
   */
  const getCenterGroups = useCallback(() => {
    if (!dockviewApi) return [];
    return dockviewApi.groups.filter((g) => {
      const ids = g.panels.map((p) => p.id);
      const isLeft = ids.some((id) => LEFT_PANEL_IDS.has(id));
      const isBottom = ids.some((id) => BOTTOM_PANEL_IDS.has(id));
      return !isLeft && !isBottom;
    });
  }, [dockviewApi]);

  const toggleCenter1Visibility = useCallback(() => {
    if (!dockviewApi) return;
    const group =
      dockviewApi.getGroup(GROUP_IDS.CENTER_1) ??
      dockviewApi.getPanel(PANEL_IDS.WELCOME)?.group;
    if (!group) return;
    group.api.setVisible(!group.api.isVisible);
  }, [dockviewApi]);

  const toggleCenter2Visibility = useCallback(() => {
    if (!dockviewApi) return;
    const center2Group = dockviewApi.getGroup(GROUP_IDS.CENTER_2);
    if (center2Group) {
      center2Group.api.setVisible(!center2Group.api.isVisible);
      return;
    }

    const centerGroups = getCenterGroups();
    if (centerGroups.length === 1) {
      const refPanel = centerGroups[0].panels[0];
      if (!refPanel) return;

      const targetGroup = dockviewApi.addGroup({
        id: GROUP_IDS.CENTER_2,
        referencePanel: refPanel,
        direction: 'right',
      });
      targetGroup.api.setVisible(true);

      dockviewApi.addPanel({
        id: PANEL_IDS.WELCOME + '-2',
        component: PANEL_IDS.WELCOME,
        title: '预览',
        position: {
          referenceGroup: GROUP_IDS.CENTER_2,
          direction: 'within',
        },
        inactive: true,
      });
    }
  }, [dockviewApi, getCenterGroups]);

  const isCenter1Visible = useCallback(() => {
    if (!dockviewApi) return false;
    const group =
      dockviewApi.getGroup(GROUP_IDS.CENTER_1) ??
      dockviewApi.getPanel(PANEL_IDS.WELCOME)?.group;
    return group?.api.isVisible ?? false;
  }, [dockviewApi]);

  const isCenter2Visible = useCallback(() => {
    if (dockviewApi) {
      const center2Group = dockviewApi.getGroup(GROUP_IDS.CENTER_2);
      if (center2Group) {
        return center2Group.api.isVisible;
      }
    }

    const centerGroups = getCenterGroups();
    if (centerGroups.length < 2) return false;
    return centerGroups[1].api.isVisible;
  }, [dockviewApi, getCenterGroups]);

  const value: PanelActions = {
    openOrFocusPanel,
    openFilePreview,
    openDiffPreview,
    openNewTerminal,
    closePanel,
    toggleFileTree,
    toggleGitPanel,
    toggleSearchPanel,
    isPanelOpen,
    focusKanban,
    openLogs,
    openNotes,
    toggleCenter1Visibility,
    toggleCenter2Visibility,
    isCenter1Visible,
    isCenter2Visible,
    setDockviewApi,
  };

  return (
    <PanelActionsContext.Provider value={value}>
      {children}
    </PanelActionsContext.Provider>
  );
}

/**
 * Hook to access panel actions from anywhere in the component tree.
 * Must be used within a PanelActionsProvider.
 */
export function usePanelActionsContext(): PanelActions {
  const ctx = useContext(PanelActionsContext);
  if (!ctx) {
    throw new Error(
      'usePanelActionsContext must be used within a PanelActionsProvider'
    );
  }
  return ctx;
}

export function useOptionalPanelActionsContext(): PanelActions | null {
  return useContext(PanelActionsContext);
}
