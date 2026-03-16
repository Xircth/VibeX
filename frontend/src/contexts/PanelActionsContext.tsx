import {
  createContext,
  useContext,
  useCallback,
  useRef,
  useMemo,
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
  /** Open the diff preview panel in commit diff mode */
  openCommitDiff: () => void;
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
  // Use ref to store dockviewApi so callbacks don't need it as a dependency.
  // This prevents all consumers from re-rendering when dockviewApi changes.
  const apiRef = useRef<DockviewApi | null>(null);

  const setDockviewApi = useCallback((api: DockviewApi | null) => {
    apiRef.current = api;
  }, []);

  const getCenter1Group = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return undefined;
    return (
      dockviewApi.getGroup(GROUP_IDS.CENTER_1) ??
      dockviewApi.getPanel(PANEL_IDS.WELCOME)?.group
    );
  }, []);

  const ensureCenter1Group = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return undefined;

    const existing = getCenter1Group();
    if (existing) return existing;

    // Center-1 was destroyed – rebuild by adding a welcome panel with positioning.
    // This creates the group as a side-effect, avoiding the addGroup ID registration issue.
    const leftGroup = dockviewApi.getGroup(GROUP_IDS.LEFT);
    const refPanel = leftGroup?.panels[0] ?? dockviewApi.panels[0];
    if (!refPanel) return undefined;

    // Remove orphaned welcome panel if it exists in an unexpected location
    const orphanedWelcome = dockviewApi.getPanel(PANEL_IDS.WELCOME);
    if (orphanedWelcome) {
      try { dockviewApi.removePanel(orphanedWelcome); } catch { /* ignore */ }
    }

    const welcomePanel = dockviewApi.addPanel({
      id: PANEL_IDS.WELCOME,
      component: PANEL_IDS.WELCOME,
      title: 'Welcome',
      position: {
        referencePanel: refPanel,
        direction: leftGroup ? 'right' : 'within',
      },
      inactive: true,
    });

    // Force-set the group ID to match our constant (same pattern as normalizeCanonicalGroupIds)
    const center1Group = welcomePanel.group;
    (center1Group as unknown as { id: string }).id = GROUP_IDS.CENTER_1;

    return center1Group;
  }, [getCenter1Group]);

  /**
   * Find center-2 group by ID, by welcome-2 panel, or by exclusion.
   * Handles the case where fromJSON restores groups with non-canonical IDs.
   */
  const findCenter2Group = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return undefined;

    // Try canonical ID first
    const byId = dockviewApi.getGroup(GROUP_IDS.CENTER_2);
    if (byId) return byId;

    // Try welcome-2 panel reference
    const byWelcome = dockviewApi.getPanel(`${PANEL_IDS.WELCOME}-2`)?.group;
    if (byWelcome) return byWelcome;

    // Fallback: find by exclusion (any center group that's not center-1)
    const center1Group = getCenter1Group();
    return dockviewApi.groups.find((g) => {
      if (g === center1Group) return false;
      const pIds = g.panels.map((p) => p.id);
      if (pIds.some((id) => LEFT_PANEL_IDS.has(id))) return false;
      if (pIds.some((id) => BOTTOM_PANEL_IDS.has(id))) return false;
      return true;
    });
  }, [getCenter1Group]);

  const ensureCenter2Group = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return undefined;

    const existingCenter2 = findCenter2Group();
    if (existingCenter2) {
      return existingCenter2;
    }

    // Ensure center-1 exists first so we have a reliable reference
    const center1 = ensureCenter1Group();
    const refPanel =
      center1?.panels[0] ?? dockviewApi.getPanel(PANEL_IDS.WELCOME) ?? dockviewApi.panels[0];
    if (!refPanel) return undefined;

    // Remove orphaned welcome-2 panel if it exists in an unexpected location
    const orphanedWelcome2 = dockviewApi.getPanel(`${PANEL_IDS.WELCOME}-2`);
    if (orphanedWelcome2) {
      try { dockviewApi.removePanel(orphanedWelcome2); } catch { /* ignore */ }
    }

    // Create welcome-2 panel with positioning – group is created as a side-effect
    const welcome2Panel = dockviewApi.addPanel({
      id: `${PANEL_IDS.WELCOME}-2`,
      component: PANEL_IDS.WELCOME,
      title: 'Preview',
      position: {
        referencePanel: refPanel,
        direction: 'right',
      },
      inactive: true,
    });

    // Force-set the group ID (same pattern as normalizeCanonicalGroupIds)
    const center2Group = welcome2Panel.group;
    (center2Group as unknown as { id: string }).id = GROUP_IDS.CENTER_2;

    return center2Group;
  }, [findCenter2Group, ensureCenter1Group]);

  const chooseCenterGroupForNewPanel = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return undefined;

    const center1Group = ensureCenter1Group();
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
  }, [ensureCenter1Group, ensureCenter2Group]);

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
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      // 1. Already exists → activate
      const existingPanel = dockviewApi.getPanel(panelId);
      if (existingPanel) {
        existingPanel.group.api.setVisible(true);
        existingPanel.api.setActive();
        return;
      }

      const targetGroup = chooseCenterGroupForNewPanel();
      if (targetGroup && targetGroup.panels.length > 0) {
        targetGroup.api.setVisible(true);
        dockviewApi.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: {
            referencePanel: targetGroup.panels[0],
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
    [chooseCenterGroupForNewPanel]
  );

  const openFilePreview = useCallback(
    (filePath: string) => {
      const dockviewApi = apiRef.current;
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

      if (targetGroup && targetGroup.panels.length > 0) {
        targetGroup.api.setVisible(true);
        dockviewApi.addPanel({
          id: panelId,
          component: PANEL_IDS.PREVIEW,
          title: fileName,
          params: { filePath },
          position: {
            referencePanel: targetGroup.panels[0],
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
    [chooseCenterGroupForNewPanel]
  );

  const openDiffPreview = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.DIFFS, 'Diffs');
  }, [openOrFocusPanel]);

  const openCommitDiff = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.DIFFS, 'Commit Diff');
  }, [openOrFocusPanel]);

  const openNewTerminal = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return;

    const existingTerminal = dockviewApi.getPanel(PANEL_IDS.TERMINAL);
    let bottomGroup = dockviewApi.getGroup(GROUP_IDS.BOTTOM);

    // Case 1: Both terminal and bottom group exist — just toggle visibility
    if (existingTerminal && bottomGroup) {
      bottomGroup.api.setVisible(!bottomGroup.api.isVisible);
      return;
    }

    // Case 2: Bottom group exists but terminal was removed — re-add terminal
    if (bottomGroup && !existingTerminal) {
      bottomGroup.api.setVisible(true);
      dockviewApi.addPanel({
        id: PANEL_IDS.TERMINAL,
        component: PANEL_IDS.TERMINAL,
        title: 'Terminal',
        position: { referenceGroup: GROUP_IDS.BOTTOM, direction: 'within' },
      });
      return;
    }

    // Case 3: No bottom group — create it simply below center-1
    // (Tree position may not span CENTER_2, but this avoids destroying CENTER_2 panels.
    //  Correct spanning is ensured on next layout restore via validateTerminalPosition.)
    const center1Group = dockviewApi.getGroup(GROUP_IDS.CENTER_1)
      ?? dockviewApi.getPanel(PANEL_IDS.WELCOME)?.group;
    const center1RefPanel = center1Group?.panels[0];
    if (!center1RefPanel) return;

    bottomGroup = dockviewApi.addGroup({
      id: GROUP_IDS.BOTTOM,
      referencePanel: center1RefPanel,
      direction: 'below',
      locked: 'no-drop-target',
      initialHeight: DEFAULT_TERMINAL_PANEL_HEIGHT,
    });
    bottomGroup.locked = 'no-drop-target';

    dockviewApi.addPanel({
      id: PANEL_IDS.TERMINAL,
      component: PANEL_IDS.TERMINAL,
      title: 'Terminal',
      position: { referenceGroup: GROUP_IDS.BOTTOM, direction: 'within' },
    });
  }, []);

  const closePanel = useCallback(
    (panelId: string) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;
      const panel = dockviewApi.getPanel(panelId);
      if (panel) {
        dockviewApi.removePanel(panel);
      }
    },
    []
  );

  /**
   * Helper: switch the left sidebar to a different panel.
   * Adds the new panel BEFORE removing old ones so the group is never empty
   * (preventing dockview from auto-destroying the group).
   */
  const switchLeftPanel = useCallback(
    (
      targetId: string,
      targetComponent: string,
      targetTitle: string,
      otherPanelIds: string[]
    ) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return;

      // If target panel already exists, check whether we need to switch or toggle
      const existing = dockviewApi.getPanel(targetId);
      if (existing) {
        const leftGroup =
          dockviewApi.getGroup(GROUP_IDS.LEFT) ??
          dockviewApi.groups.find((g) =>
            g.panels.some((p) => p.id === targetId)
          );
        if (leftGroup) {
          // Check if other left panels also exist in the group (e.g. after layout restore)
          const hasOtherLeftPanels = otherPanelIds.some(
            (id) => !!dockviewApi.getPanel(id)
          );

          if (hasOtherLeftPanels) {
            // Switch mode: activate target, remove stale panels, ensure visible
            existing.api.setActive();
            for (const otherId of otherPanelIds) {
              const otherPanel = dockviewApi.getPanel(otherId);
              if (otherPanel) {
                dockviewApi.removePanel(otherPanel);
              }
            }
            leftGroup.api.setVisible(true);
            applyLeftGroupHeaderHiding(dockviewApi);
          } else {
            // Pure toggle: no other left panels, just toggle sidebar visibility
            leftGroup.api.setVisible(!leftGroup.api.isVisible);
          }
        }
        return;
      }

      // Find existing left group and save its width
      const existingLeftGroup =
        dockviewApi.getGroup(GROUP_IDS.LEFT) ??
        dockviewApi.groups.find((g) =>
          g.panels.some((p) => LEFT_PANEL_IDS.has(p.id))
        );
      const savedLeftWidth =
        existingLeftGroup?.api.isVisible ? existingLeftGroup.api.width : 0;

      let leftGroup = existingLeftGroup ?? null;

      if (!leftGroup) {
        // No left group exists — create one
        const centerRef = dockviewApi.panels.find(
          (p) => !LEFT_PANEL_IDS.has(p.id) && !BOTTOM_PANEL_IDS.has(p.id)
        );
        if (!centerRef) return;
        leftGroup = dockviewApi.addGroup({
          id: GROUP_IDS.LEFT,
          referencePanel: centerRef,
          direction: 'left',
          hideHeader: true,
          initialWidth: savedLeftWidth > 0 ? savedLeftWidth : 220,
        });
        if (savedLeftWidth > 0) {
          try {
            leftGroup.api.setSize({ width: savedLeftWidth });
          } catch {
            /* ignore */
          }
        }
      }

      // Add the new panel FIRST (group stays non-empty, won't be destroyed)
      dockviewApi.addPanel({
        id: targetId,
        component: targetComponent,
        title: targetTitle,
        position: { referenceGroup: GROUP_IDS.LEFT, direction: 'within' },
      });

      // Now safely remove the old panels
      for (const otherId of otherPanelIds) {
        const otherPanel = dockviewApi.getPanel(otherId);
        if (otherPanel) {
          dockviewApi.removePanel(otherPanel);
        }
      }

      leftGroup.api.setVisible(true);
      applyLeftGroupHeaderHiding(dockviewApi);
    },
    []
  );

  const toggleFileTree = useCallback(() => {
    switchLeftPanel(
      PANEL_IDS.FILE_TREE,
      PANEL_IDS.FILE_TREE,
      '文件管理器',
      [PANEL_IDS.GIT, PANEL_IDS.SEARCH]
    );
  }, [switchLeftPanel]);

  const toggleGitPanel = useCallback(() => {
    switchLeftPanel(
      PANEL_IDS.GIT,
      PANEL_IDS.GIT,
      'Git 管理器',
      [PANEL_IDS.FILE_TREE, PANEL_IDS.SEARCH]
    );
  }, [switchLeftPanel]);

  const toggleSearchPanel = useCallback(() => {
    switchLeftPanel(
      PANEL_IDS.SEARCH,
      PANEL_IDS.SEARCH,
      '搜索',
      [PANEL_IDS.FILE_TREE, PANEL_IDS.GIT]
    );
  }, [switchLeftPanel]);

  const isPanelOpen = useCallback(
    (panelId: string) => {
      const dockviewApi = apiRef.current;
      if (!dockviewApi) return false;
      const panel = dockviewApi.getPanel(panelId);
      if (!panel) return false;
      // For left sidebar panels, also check group visibility and active state
      // so the Activity Bar icon accurately reflects what's actually shown
      if (LEFT_PANEL_IDS.has(panelId)) {
        return panel.group.api.isVisible && panel.api.isActive;
      }
      return true;
    },
    []
  );

  const openLogs = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.LOGS, 'Logs');
  }, [openOrFocusPanel]);

  const openNotes = useCallback(() => {
    openOrFocusPanel(PANEL_IDS.NOTES, '笔记');
  }, [openOrFocusPanel]);

  const focusKanban = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return;
    const kanbanPanel = dockviewApi.getPanel(PANEL_IDS.KANBAN);
    if (kanbanPanel) {
      kanbanPanel.api.setActive();
    }
  }, []);

  const toggleCenter1Visibility = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return;
    const existingGroup = getCenter1Group();
    if (existingGroup) {
      existingGroup.api.setVisible(!existingGroup.api.isVisible);
      return;
    }
    // Group was destroyed – rebuild and show it
    const rebuilt = ensureCenter1Group();
    if (rebuilt) {
      rebuilt.api.setVisible(true);
    }
  }, [getCenter1Group, ensureCenter1Group]);

  const toggleCenter2Visibility = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return;

    // Use robust detection (handles fromJSON ID mismatch)
    const center2Group = findCenter2Group();
    if (center2Group) {
      center2Group.api.setVisible(!center2Group.api.isVisible);
      return;
    }

    // Group was destroyed – rebuild it via ensureCenter2Group
    const rebuilt = ensureCenter2Group();
    if (rebuilt) {
      rebuilt.api.setVisible(true);
    }
  }, [findCenter2Group, ensureCenter2Group]);

  const isCenter1Visible = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return false;
    const group =
      dockviewApi.getGroup(GROUP_IDS.CENTER_1) ??
      dockviewApi.getPanel(PANEL_IDS.WELCOME)?.group;
    return group?.api.isVisible ?? false;
  }, []);

  const isCenter2Visible = useCallback(() => {
    const dockviewApi = apiRef.current;
    if (!dockviewApi) return false;
    const center2Group = findCenter2Group();
    return center2Group?.api.isVisible ?? false;
  }, [findCenter2Group]);

  const value: PanelActions = useMemo(
    () => ({
      openOrFocusPanel,
      openFilePreview,
      openDiffPreview,
      openCommitDiff,
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
    }),
    [
      openOrFocusPanel,
      openFilePreview,
      openDiffPreview,
      openCommitDiff,
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
    ]
  );

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
