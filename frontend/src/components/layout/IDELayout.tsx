import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewApi,
} from 'dockview-react';
import type { DockviewWillShowOverlayLocationEvent } from 'dockview-core';
import { FolderOpen, GitBranch, Search } from 'lucide-react';

import { panelComponents } from '@/components/layout/panels/PanelRegistry';
import { TerminalHeaderActions } from '@/components/layout/panels/TerminalHeaderActions';
import { StatusBar } from '@/components/layout/StatusBar';
import { useLayoutStore, PANEL_IDS, GROUP_IDS } from '@/stores/useLayoutStore';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { applyLeftGroupHeaderHiding } from '@/utils/dockviewHelpers';
import { KanbanBoard } from '@/components/panels/DockviewKanbanPanel';
import { DEFAULT_TERMINAL_PANEL_HEIGHT } from '@/lib/terminalPreferences';
import { SearchPalette } from '@/components/search/SearchPalette';
import { useGlobalSearchShortcut } from '@/hooks/useGlobalSearchShortcut';
// Loaded as raw string via Vite ?raw import, then injected at runtime in useEffect.
// This ensures our overrides appear AFTER dockview's styleInject() in <head>,
// so our CSS variables and !important rules take precedence.
import DOCKVIEW_AYU_CSS from '@/styles/dockview-ayu.css?raw';

// ── Layout constants ──
const LAYOUT = {
  LEFT_PANEL_DEFAULT_WIDTH: 220,
  LEFT_PANEL_MIN_WIDTH: 200,
  LEFT_PANEL_MAX_RATIO: 0.4,
  LAYOUT_RESTORE_DELAY_MS: 100,
  /** Max rAF retries for applyDefaultSizes waiting on container width */
  DEFAULT_SIZE_RETRIES: 15,
  /** Max rAF retries for initial width clamping after fromJSON */
  CLAMP_INITIAL_RETRIES: 10,
  /** Debounce delay (ms) for persisting layout on onDidLayoutChange */
  LAYOUT_CHANGE_DEBOUNCE_MS: 500,
  /** requestIdleCallback timeout (ms) for layout serialization */
  IDLE_PERSIST_TIMEOUT_MS: 1000,
} as const;

interface IDELayoutProps {
  /** Content for the right fixed panel (AI Chat area) */
  rightPanelContent?: ReactNode;
  /** Content for the toolbar */
  toolbarContent?: ReactNode;
}

/**
 * IDELayout - The main dockview-based IDE layout component.
 *
 * Layout structure:
 * - Left: File tree (optional sidebar)
 * - Center: Main editor area with tabs (Kanban, Preview, Diffs)
 * - Bottom: Terminal area
 * - Right: Fixed AI chat panel (not part of dockview)
 */
export function IDELayout({ rightPanelContent, toolbarContent }: IDELayoutProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const { activeWorktreeId } = useWorktree();
  const {
    serializedLayout,
    setSerializedLayout,
    isRightPanelVisible,
    rightPanelWidth,
    setRightPanelWidth,
    activeTab,
  } = useLayoutStore();

  // Use ref for serializedLayout so handleReady doesn't need it as dependency
  const serializedLayoutRef = useRef(serializedLayout);
  serializedLayoutRef.current = serializedLayout;

  const { setDockviewApi, toggleFileTree, toggleGitPanel, toggleSearchPanel, isPanelOpen } = usePanelActionsContext();

  // Track layout version to trigger re-renders when panels change
  const [, setLayoutVersion] = useState(0);

  // Guard against re-entrant onDidLayoutChange → setSize → onDidLayoutChange loops
  const isClampingRef = useRef(false);
  const layoutChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard to suppress layout saves during reset/rebuild
  const isResettingRef = useRef(false);

  /**
   * Apply canonical default sizes for left sidebar and bottom terminal after layout build.
   *
   * dockview's initialWidth/initialHeight are proportional hints, not absolute pixels.
   * When buildDefaultLayout runs, the container may not have final DOM dimensions yet
   * (api.width === 0), causing dockview to stretch the hints proportionally.
   * This function retries via rAF until the container has a real width, then forces
   * the correct pixel sizes via api.setSize().
   */
  const applyDefaultSizes = useCallback((api: DockviewApi, retries: number = LAYOUT.DEFAULT_SIZE_RETRIES, onDone?: () => void) => {
    const containerWidth = api.width;

    // Retry until the container has rendered and has a valid width
    if (containerWidth <= 0 && retries > 0) {
      requestAnimationFrame(() => applyDefaultSizes(api, retries - 1, onDone));
      return;
    }

    try {
      // Use the declared default widths/heights as absolute pixel values.
      // These match initialWidth/initialHeight in buildDefaultLayout.
      const leftGroup = api.getGroup(GROUP_IDS.LEFT);
      if (leftGroup && leftGroup.api.isVisible) {
        leftGroup.api.setSize({ width: LAYOUT.LEFT_PANEL_DEFAULT_WIDTH });
      }

      const terminalPanel = api.getPanel(PANEL_IDS.TERMINAL);
      if (terminalPanel) {
        const bottomGroup = terminalPanel.group;
        if (bottomGroup && bottomGroup.api.isVisible) {
          bottomGroup.api.setSize({ height: DEFAULT_TERMINAL_PANEL_HEIGHT });
        }
      }
    } catch {
      // Ignore resize errors during transitions
    }

    onDone?.();
  }, []);

  /**
   * Build the default layout when no persisted layout exists.
   *
   * Layout:
   * ┌──────────┬──────────┬──────────┐
   * │ Left     │ Center-1 │ Center-2 │
   * │(FileTree)│ (Kanban) │(Welcome) │
   * │ no tabs  ├──────────┴──────────┤
   * │          │     Terminal        │
   * └──────────┴─────────────────────┘
   */
  const buildDefaultLayout = useCallback((api: DockviewApi) => {
    // Workspace mode: no kanban panel in dockview (kanban is a separate overlay).
    // Build order:
    // 1. Welcome (center anchor) → 2. Left file tree → 3. Terminal below welcome
    //
    // IMPORTANT: Left group must be added BEFORE terminal so that the terminal
    // group only spans the center column width, not the full container width.
    // If terminal is added first (before left), it gets full-width and visually
    // invades the left sidebar space on initialization.

    // 1. Welcome — center anchor
    const welcomePanel = api.addPanel({
      id: PANEL_IDS.WELCOME,
      component: PANEL_IDS.WELCOME,
      title: '欢迎',
    });
    (welcomePanel.group as { id: string }).id = GROUP_IDS.CENTER_1;

    // 2. Left group with hidden header — file tree (add BEFORE terminal)
    const leftGroup = api.addGroup({
      id: GROUP_IDS.LEFT,
      referencePanel: welcomePanel,
      direction: 'left',
      hideHeader: true,
      initialWidth: LAYOUT.LEFT_PANEL_DEFAULT_WIDTH,
    });
    api.addPanel({
      id: PANEL_IDS.FILE_TREE,
      component: PANEL_IDS.FILE_TREE,
      title: '文件管理器',
      position: {
        referenceGroup: leftGroup,
        direction: 'within',
      },
    });

    // 3. Bottom group with terminal – below welcome
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
        referenceGroup: GROUP_IDS.BOTTOM,
        direction: 'within',
      },
      inactive: true,
    });

    // 4. Second center group – explicit group id for center-2
    api.addGroup({
      id: GROUP_IDS.CENTER_2,
      referencePanel: welcomePanel,
      direction: 'right',
    });
    api.addPanel({
      id: PANEL_IDS.WELCOME + '-2',
      component: PANEL_IDS.WELCOME,
      title: 'Preview',
      position: {
        referenceGroup: GROUP_IDS.CENTER_2,
        direction: 'within',
      },
      inactive: true,
    });

    // Apply CSS class for left group header hiding
    applyLeftGroupHeaderHiding(api);
  }, []);

  /**
   * Create bottom group at the correct level in the dockview layout tree.
   *
   * The bottom group must span across ALL center groups (center-1 + center-2).
   * In dockview, the tree structure depends on creation order:
   *   addGroup(below CENTER_1) THEN addGroup(right CENTER_1) → bottom spans both ✓
   *   addGroup(right CENTER_1) THEN addGroup(below CENTER_1) → bottom only under center-1 ✗
   *
   * When CENTER_2 already exists, we must temporarily remove it, add bottom,
   * then re-add CENTER_2 to get the correct tree hierarchy.
   */
  const createBottomGroupCorrectly = useCallback((api: DockviewApi, initialHeight?: number): ReturnType<DockviewApi['addGroup']> | undefined => {
    const height = initialHeight ?? DEFAULT_TERMINAL_PANEL_HEIGHT;

    // Find center-1 reference panel, verifying its group is tracked by dockview
    const center1Group = api.getGroup(GROUP_IDS.CENTER_1) ?? api.getPanel(PANEL_IDS.WELCOME)?.group;
    const center1RefPanel = center1Group?.panels[0];
    if (!center1RefPanel) return undefined;
    // Verify the panel's group actually exists in dockview's internal tracking
    // (after removeGroup, stale panel objects may linger with detached groups)
    const verifiedGroup = api.getGroup(center1Group!.id);
    if (!verifiedGroup) return undefined;

    // Find CENTER_2 by ID or by exclusion (any group that's not LEFT, not BOTTOM, not CENTER_1)
    const center2Group = api.getGroup(GROUP_IDS.CENTER_2) ?? (() => {
      const leftPanelIdArr = [PANEL_IDS.FILE_TREE, PANEL_IDS.GIT, PANEL_IDS.SEARCH] as string[];
      return api.groups.find((g) => {
        if (g === center1Group) return false;
        if (g.id === GROUP_IDS.LEFT || g.id === GROUP_IDS.BOTTOM) return false;
        const pIds = g.panels.map((p) => p.id);
        if (pIds.some((id) => leftPanelIdArr.includes(id) || id === PANEL_IDS.TERMINAL)) return false;
        return true;
      });
    })();
    if (!center2Group) {
      const bottomGroup = api.addGroup({
        id: GROUP_IDS.BOTTOM,
        referencePanel: center1RefPanel,
        direction: 'below',
        locked: 'no-drop-target',
        initialHeight: height,
      });
      bottomGroup.locked = 'no-drop-target';
      return bottomGroup;
    }

    // CENTER_2 exists — we must restructure:
    // 1. Remember CENTER_2 panel info
    // 2. Remove CENTER_2 entirely
    // 3. Add BOTTOM (now spans full center area)
    // 4. Re-create CENTER_2 with its panels
    const center2PanelInfos: Array<{ id: string; component: string; title: string }> = [];
    for (const panel of [...center2Group.panels]) {
      center2PanelInfos.push({
        id: panel.id,
        component: (panel as unknown as { _component: string })._component ?? panel.id,
        title: panel.title ?? panel.id,
      });
    }

    // Remove CENTER_2 group and all its panels
    api.removeGroup(center2Group);

    // Use panel ID string (not stale object) so dockview re-looks up the panel
    // from its current internal state after the removeGroup restructuring.
    const center1RefPanelId = center1RefPanel.id;

    // Add bottom group relative to center-1 (only center group now)
    const bottomGroup = api.addGroup({
      id: GROUP_IDS.BOTTOM,
      referencePanel: center1RefPanelId,
      direction: 'below',
      locked: 'no-drop-target',
      initialHeight: height,
    });
    bottomGroup.locked = 'no-drop-target';

    // Re-create CENTER_2 with its panels
    if (center2PanelInfos.length > 0) {
      api.addGroup({
        id: GROUP_IDS.CENTER_2,
        referencePanel: center1RefPanelId,
        direction: 'right',
      });
      for (const info of center2PanelInfos) {
        api.addPanel({
          id: info.id,
          component: info.component,
          title: info.title,
          position: {
            referenceGroup: GROUP_IDS.CENTER_2,
            direction: 'within',
          },
          inactive: true,
        });
      }
    }

    return bottomGroup;
  }, []);

  const normalizeCanonicalGroupIds = useCallback((api: DockviewApi) => {
    // 1. Identify LEFT group by its characteristic panels
    const leftGroup = api.groups.find((group) =>
      group.panels.some(
        (panel) => panel.id === PANEL_IDS.FILE_TREE || panel.id === PANEL_IDS.GIT || panel.id === PANEL_IDS.SEARCH
      )
    );
    if (leftGroup) {
      (leftGroup as { id: string }).id = GROUP_IDS.LEFT;
    }

    // 2. Identify BOTTOM group by terminal panel
    const bottomGroup = api.groups.find((group) =>
      group.panels.some((panel) => panel.id === PANEL_IDS.TERMINAL)
    );
    if (bottomGroup) {
      (bottomGroup as { id: string }).id = GROUP_IDS.BOTTOM;
      bottomGroup.locked = 'no-drop-target';
    }

    // 3. Identify CENTER groups by exclusion (not LEFT, not BOTTOM)
    //    First try to match by welcome placeholder panels, then fall back to positional order.
    const leftGroupId = leftGroup?.id;
    const bottomGroupId = bottomGroup?.id;
    const centerGroups = api.groups.filter((g) => {
      if (leftGroupId && g.id === leftGroupId) return false;
      if (bottomGroupId && g.id === bottomGroupId) return false;
      // Also exclude by panel content (in case IDs haven't been set yet)
      const panelIds = g.panels.map((p) => p.id);
      const isLeft = panelIds.some((id) => id === PANEL_IDS.FILE_TREE || id === PANEL_IDS.GIT || id === PANEL_IDS.SEARCH);
      const isBottom = panelIds.some((id) => id === PANEL_IDS.TERMINAL);
      return !isLeft && !isBottom;
    });

    // Try welcome-panel matching first (most reliable)
    const welcomeGroup = api.getPanel(PANEL_IDS.WELCOME)?.group;
    const welcome2Group = api.getPanel(`${PANEL_IDS.WELCOME}-2`)?.group;

    if (welcomeGroup) {
      (welcomeGroup as { id: string }).id = GROUP_IDS.CENTER_1;
    }
    if (welcome2Group && welcome2Group !== welcomeGroup) {
      (welcome2Group as { id: string }).id = GROUP_IDS.CENTER_2;
    }

    // Fall back to positional assignment for center groups missing welcome panels
    if (!welcomeGroup && !welcome2Group && centerGroups.length > 0) {
      // Assign by order: first center → CENTER_1, second → CENTER_2
      (centerGroups[0] as { id: string }).id = GROUP_IDS.CENTER_1;
      if (centerGroups.length > 1) {
        (centerGroups[1] as { id: string }).id = GROUP_IDS.CENTER_2;
      }
    } else if (!welcomeGroup && centerGroups.length > 0) {
      // WELCOME panel missing but welcome-2 exists; find center group that isn't CENTER_2
      const center1Candidate = centerGroups.find((g) => g !== welcome2Group);
      if (center1Candidate) {
        (center1Candidate as { id: string }).id = GROUP_IDS.CENTER_1;
      }
    } else if (!welcome2Group && centerGroups.length > 1) {
      // WELCOME-2 missing; find center group that isn't CENTER_1
      const center2Candidate = centerGroups.find((g) => g !== welcomeGroup);
      if (center2Candidate) {
        (center2Candidate as { id: string }).id = GROUP_IDS.CENTER_2;
      }
    }

    applyLeftGroupHeaderHiding(api);
  }, []);

  /**
   * Register dockview drag-drop guard via api.onWillShowOverlay.
   * Prevents non-left panels (terminal, kanban, etc.) from being dropped
   * into the left sidebar group.
   */
  const registerDndGuard = useCallback((api: DockviewApi) => {
    return api.onWillShowOverlay((event) => {
      const ev: DockviewWillShowOverlayLocationEvent = event;
      const targetGroup = ev.group;
      if (!targetGroup) return;

      const draggedPanelId = ev.panel?.id;
      if (draggedPanelId === PANEL_IDS.TERMINAL) {
        event.preventDefault();
        return;
      }

      const targetPanelIds = targetGroup.panels.map((p: { id: string }) => p.id);
      const isTargetLeftGroup = targetPanelIds.some(
        (id: string) => id === PANEL_IDS.FILE_TREE || id === PANEL_IDS.GIT
      );
      const isTargetBottomGroup =
        targetGroup.id === GROUP_IDS.BOTTOM ||
        targetGroup.panels.some((p: { id: string }) => p.id === PANEL_IDS.TERMINAL);
      const isSourceLeftPanel =
        draggedPanelId === PANEL_IDS.FILE_TREE ||
        draggedPanelId === PANEL_IDS.GIT;

      if (isTargetBottomGroup) {
        event.preventDefault();
        return;
      }

      if (isTargetLeftGroup && draggedPanelId) {
        if (!isSourceLeftPanel) {
          event.preventDefault();
          return;
        }
      }

      if (isSourceLeftPanel && !isTargetLeftGroup) {
        event.preventDefault();
        return;
      }

      const isTargetCenterGroup = !isTargetLeftGroup && !isTargetBottomGroup;
      const isSourceCenterPanel =
        !!draggedPanelId &&
        !isSourceLeftPanel &&
        draggedPanelId !== PANEL_IDS.TERMINAL;

      if (isSourceCenterPanel && isTargetCenterGroup) {
        return;
      }
    });
  }, []);

  /**
   * Validate terminal position after layout restore.
   * If terminal ended up in the left sidebar group, move it back to center/bottom.
   */
  /**
   * Validate and fix terminal position after layout restore.
   * Always rebuilds bottom group at the correct tree level to ensure
   * it spans all center groups (not just center-1).
   */
  const validateTerminalPosition = useCallback((api: DockviewApi) => {
    const terminalPanel = api.getPanel(PANEL_IDS.TERMINAL);
    if (!terminalPanel) return;

    const termGroup = terminalPanel.group;
    const termHeight = termGroup.api.height || DEFAULT_TERMINAL_PANEL_HEIGHT;
    const wasVisible = termGroup.api.isVisible;

    // Check if terminal's current group is correctly positioned.
    // If the terminal group IS the bottom group and has no non-terminal panels, it might be fine.
    // However, fromJSON often restores it at the wrong tree level, so we need to check.
    const leftPanelIdArr = [PANEL_IDS.FILE_TREE, PANEL_IDS.GIT, PANEL_IDS.SEARCH] as string[];
    const isTermInLeftGroup = termGroup.panels.some((p) => leftPanelIdArr.includes(p.id));

    // If terminal is in the left group, definitely needs fixing
    // Otherwise, check if bottom group spans correctly by examining center group count
    if (!isTermInLeftGroup) {
      // Count center groups (not left, not bottom)
      const centerGroupCount = api.groups.filter((g) => {
        if (g === termGroup) return false;
        const pIds = g.panels.map((p) => p.id);
        if (pIds.some((id) => leftPanelIdArr.includes(id))) return false;
        if (pIds.some((id) => id === PANEL_IDS.TERMINAL)) return false;
        return true;
      }).length;

      // If only 0 or 1 center group, the tree structure can't be wrong
      if (centerGroupCount <= 1) {
        termGroup.locked = 'no-drop-target';
        (termGroup as { id: string }).id = GROUP_IDS.BOTTOM;
        return;
      }
    }

    // Rebuild: remove terminal and its old group, recreate at correct tree level
    api.removePanel(terminalPanel);

    // Remove old bottom group if it exists and is empty
    const oldBottomGroup = api.getGroup(GROUP_IDS.BOTTOM) ?? (termGroup.panels.length === 0 ? termGroup : null);
    if (oldBottomGroup && oldBottomGroup.panels.length === 0) {
      try { api.removeGroup(oldBottomGroup); } catch { /* ignore */ }
    }

    // If bottom group still has other panels, just re-add terminal
    const existingBottom = api.getGroup(GROUP_IDS.BOTTOM);
    if (existingBottom && existingBottom.panels.length > 0) {
      existingBottom.locked = 'no-drop-target';
      api.addPanel({
        id: PANEL_IDS.TERMINAL,
        component: PANEL_IDS.TERMINAL,
        title: 'Terminal',
        position: { referenceGroup: GROUP_IDS.BOTTOM, direction: 'within' },
        inactive: true,
      });
      return;
    }

    // Create bottom group at the correct tree level
    const bottomGroup = createBottomGroupCorrectly(api, termHeight);
    if (!bottomGroup) return;

    api.addPanel({
      id: PANEL_IDS.TERMINAL,
      component: PANEL_IDS.TERMINAL,
      title: 'Terminal',
      position: { referenceGroup: GROUP_IDS.BOTTOM, direction: 'within' },
      inactive: true,
    });

    if (!wasVisible) {
      bottomGroup.api.setVisible(false);
    }
  }, [createBottomGroupCorrectly]);

  /**
   * Handle dockview ready event.
   */
  /**
   * Clamp panel widths to prevent left sidebar / terminal from
   * exceeding reasonable bounds. Guarded by isClampingRef to
   * prevent re-entrant onDidLayoutChange → setSize loops.
   */
  const clampPanelWidths = useCallback((api: DockviewApi) => {
    if (isClampingRef.current) return;
    isClampingRef.current = true;
    try {
      const containerWidth = api.width;
      if (containerWidth <= 0) return;

      const leftGroup = api.getGroup(GROUP_IDS.LEFT);
      if (leftGroup && leftGroup.api.isVisible) {
        const leftWidth = leftGroup.api.width;
        const maxLeftWidth = containerWidth * LAYOUT.LEFT_PANEL_MAX_RATIO;
        if (leftWidth > maxLeftWidth && maxLeftWidth > LAYOUT.LEFT_PANEL_MIN_WIDTH) {
          leftGroup.api.setSize({ width: maxLeftWidth });
        }
      }

      // NOTE: The bottom terminal group is in a vertical split and naturally
      // spans the full container width. Do NOT clamp its width — calling
      // setSize({width}) on it triggers onDidLayoutChange without actually
      // changing anything, which creates a clamp → event → clamp loop that
      // fights with user drag operations on the left sidebar.
    } catch {
      // Ignore resize errors during transitions
    } finally {
      isClampingRef.current = false;
    }
  }, []);

  const ensureWorkspacePanelsVisible = useCallback(
    (api: DockviewApi) => {
      if (!activeWorktreeId) return;

      let leftGroup = api.getGroup(GROUP_IDS.LEFT);
      if (!leftGroup) {
        const centerRef = api.getPanel(PANEL_IDS.WELCOME) ?? api.panels[0];
        if (!centerRef) return;
        leftGroup = api.addGroup({
          id: GROUP_IDS.LEFT,
          referencePanel: centerRef.id,
          direction: 'left',
          hideHeader: true,
          initialWidth: LAYOUT.LEFT_PANEL_DEFAULT_WIDTH,
        });
      }

      if (!api.getPanel(PANEL_IDS.FILE_TREE)) {
        api.addPanel({
          id: PANEL_IDS.FILE_TREE,
          component: PANEL_IDS.FILE_TREE,
          title: '文件管理器',
          position: {
            referenceGroup: GROUP_IDS.LEFT,
            direction: 'within',
          },
        });
      }
      leftGroup.api.setVisible(true);

      let bottomGroup = api.getGroup(GROUP_IDS.BOTTOM);
      if (!bottomGroup) {
        bottomGroup = createBottomGroupCorrectly(api);
        if (!bottomGroup) return;
      }

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
      bottomGroup.locked = 'no-drop-target';
      bottomGroup.api.setVisible(true);
      applyLeftGroupHeaderHiding(api);
    },
    [activeWorktreeId]
  );

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;
      setDockviewApi(api);

      // Try to restore persisted layout (read from ref to avoid stale closure)
      const layout = serializedLayoutRef.current;
      if (layout) {
        try {
          api.fromJSON(layout);
          normalizeCanonicalGroupIds(api);
          // Re-apply left group header hiding after layout restore
          applyLeftGroupHeaderHiding(api);
          // Validate terminal is not in the left group
          validateTerminalPosition(api);
          // Clamp panel widths after DOM has settled.
          // api.width may be 0 immediately after fromJSON, so we retry using
          // requestAnimationFrame until the container has a valid width.
          const clampInitialWidths = (retries: number = LAYOUT.CLAMP_INITIAL_RETRIES) => {
            const containerWidth = api.width;
            if (containerWidth <= 0 && retries > 0) {
              requestAnimationFrame(() => clampInitialWidths(retries - 1));
              return;
            }
            clampPanelWidths(api);
          };
          requestAnimationFrame(() => clampInitialWidths());
        } catch (e) {
          console.warn('Failed to restore layout, building default:', e);
          // Guard against intermediate saves during cleanup
          isResettingRef.current = true;
          // fromJSON may leave partial state — clean up before rebuilding
          for (const group of [...api.groups]) {
            try { api.removeGroup(group); } catch { /* ignore */ }
          }
          for (const panel of [...api.panels]) {
            try { api.removePanel(panel); } catch { /* ignore */ }
          }
          buildDefaultLayout(api);
          normalizeCanonicalGroupIds(api);
          isResettingRef.current = false;
          // Force exact pixel sizes after DOM renders
          requestAnimationFrame(() => applyDefaultSizes(api));
        }
      } else {
        buildDefaultLayout(api);
        normalizeCanonicalGroupIds(api);
        // initialWidth/Height are proportional hints; force exact pixel sizes after DOM renders
        requestAnimationFrame(() => applyDefaultSizes(api));
      }

      // Register drag-drop guard to prevent panels from entering left sidebar
      const dndGuardDisposable = registerDndGuard(api);

      // Intercept terminal panel close: convert to visibility toggle instead of removal.
      // When user clicks the X button on the Terminal tab, dockview removes the panel.
      // We re-add it immediately and hide the bottom group, matching Toggle Terminal behavior.
      const removePanelDisposable = api.onDidRemovePanel((panel) => {
        if (isResettingRef.current) return;

        if (panel.id === PANEL_IDS.TERMINAL) {
          try {
            // Re-add terminal panel to the bottom group
            let bottomGroup = api.getGroup(GROUP_IDS.BOTTOM);
            if (!bottomGroup) {
              bottomGroup = createBottomGroupCorrectly(api);
              if (!bottomGroup) return;
            }

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

            // Hide the bottom group (toggle off)
            bottomGroup.api.setVisible(false);
          } catch (e) {
            console.warn('Failed to re-add terminal panel after removal:', e);
          }
          return;
        }

        // Auto-hide center-2 group when only welcome placeholder panels remain.
        // This prevents an empty-looking center-2 column after the user closes
        // the last content tab.
        try {
          // Find center-2 by ID or by exclusion
          const leftPanelIdArr = [PANEL_IDS.FILE_TREE, PANEL_IDS.GIT, PANEL_IDS.SEARCH] as string[];
          const center1Group = api.getGroup(GROUP_IDS.CENTER_1)
            ?? api.getPanel(PANEL_IDS.WELCOME)?.group;
          const center2Group = api.getGroup(GROUP_IDS.CENTER_2)
            ?? api.getPanel(`${PANEL_IDS.WELCOME}-2`)?.group
            ?? api.groups.find((g) => {
              if (g === center1Group) return false;
              if (g.id === GROUP_IDS.LEFT || g.id === GROUP_IDS.BOTTOM) return false;
              const pIds = g.panels.map((p) => p.id);
              if (pIds.some((id) => leftPanelIdArr.includes(id) || id === PANEL_IDS.TERMINAL)) return false;
              return g !== center1Group;
            });

          if (center2Group && center2Group.api.isVisible) {
            const hasContentPanels = center2Group.panels.some(
              (p) => p.id !== PANEL_IDS.WELCOME && p.id !== `${PANEL_IDS.WELCOME}-2`
            );
            if (!hasContentPanels) {
              center2Group.api.setVisible(false);
            }
          }
        } catch {
          // Ignore errors during center-2 auto-hide check
        }
      });

      // Persist layout on changes and update activity bar state.
      // Debounce to avoid rapid-fire serialization and re-entrant clamp loops.
      const layoutDisposable = api.onDidLayoutChange(() => {
        // Skip saving during reset/rebuild to avoid persisting intermediate states
        if (isResettingRef.current) return;
        if (layoutChangeTimerRef.current) {
          clearTimeout(layoutChangeTimerRef.current);
        }
        layoutChangeTimerRef.current = setTimeout(() => {
          layoutChangeTimerRef.current = null;
          // Double-check reset guard (may have started during debounce)
          if (isResettingRef.current) return;
          const persistLayout = () => {
            try {
              setSerializedLayout(api.toJSON());
            } catch {
              // Ignore serialization errors during transitions
            }
          };
          if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(persistLayout, { timeout: LAYOUT.IDLE_PERSIST_TIMEOUT_MS });
          } else {
            persistLayout();
          }
          setLayoutVersion((v) => v + 1);
          clampPanelWidths(api);
        }, LAYOUT.LAYOUT_CHANGE_DEBOUNCE_MS);
      });

      return () => {
        dndGuardDisposable.dispose();
        removePanelDisposable.dispose();
        layoutDisposable.dispose();
        if (layoutChangeTimerRef.current) {
          clearTimeout(layoutChangeTimerRef.current);
        }
      };
    },
    [setSerializedLayout, buildDefaultLayout, normalizeCanonicalGroupIds, setDockviewApi, validateTerminalPosition, registerDndGuard, clampPanelWidths, applyDefaultSizes, createBottomGroupCorrectly]
  );

  // Clean up API ref on unmount
  useEffect(() => {
    return () => {
      apiRef.current = null;
      setDockviewApi(null);
    };
  }, [setDockviewApi]);

  // Track previous serializedLayout to detect reset (non-null → null)
  const prevSerializedLayoutRef = useRef(serializedLayout);
  useEffect(() => {
    const prev = prevSerializedLayoutRef.current;
    prevSerializedLayoutRef.current = serializedLayout;

    // Detect reset: previous value was non-null, now it's null
    if (prev !== null && serializedLayout === null) {
      const api = apiRef.current;
      if (!api) return;

      // Guard: suppress layout change saves during rebuild
      isResettingRef.current = true;

      // Cancel any pending debounced saves
      if (layoutChangeTimerRef.current) {
        clearTimeout(layoutChangeTimerRef.current);
        layoutChangeTimerRef.current = null;
      }

      // Remove all existing groups (which also removes their panels)
      for (const group of [...api.groups]) {
        try { api.removeGroup(group); } catch { /* ignore */ }
      }
      // Remove any orphaned panels
      for (const panel of [...api.panels]) {
        try { api.removePanel(panel); } catch { /* ignore */ }
      }

      // Rebuild default layout
      buildDefaultLayout(api);
      normalizeCanonicalGroupIds(api);

      // Unguard after sync rebuild; defer size enforcement + serialization to rAF
      // so the container has proper DOM dimensions before we apply pixel sizes.
      isResettingRef.current = false;
      applyDefaultSizes(api, LAYOUT.DEFAULT_SIZE_RETRIES, () => {
        try {
          setSerializedLayout(api.toJSON());
        } catch {
          // Ignore serialization errors
        }
      });
    }
  }, [serializedLayout, buildDefaultLayout, normalizeCanonicalGroupIds, setSerializedLayout, applyDefaultSizes]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api || !activeWorktreeId) return;

    const frame = requestAnimationFrame(() => {
      try {
        ensureWorkspacePanelsVisible(api);
      } catch (e) {
        console.warn('Failed to ensure workspace panels, rebuilding layout:', e);
        isResettingRef.current = true;
        for (const group of [...api.groups]) {
          try { api.removeGroup(group); } catch { /* ignore */ }
        }
        for (const panel of [...api.panels]) {
          try { api.removePanel(panel); } catch { /* ignore */ }
        }
        buildDefaultLayout(api);
        normalizeCanonicalGroupIds(api);
        isResettingRef.current = false;
        requestAnimationFrame(() => applyDefaultSizes(api));
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [activeWorktreeId, ensureWorkspacePanelsVisible, buildDefaultLayout, normalizeCanonicalGroupIds, applyDefaultSizes]);

  // Inject dockview theme overrides AFTER dockview's own styleInject runs.
  // dockview-react ESM bundle embeds CSS and injects it via styleInject() at import time,
  // which appends a <style> tag to <head>. Any CSS imported via Vite (link/style tags)
  // may appear BEFORE that injected style, causing our variable overrides to be
  // overridden by dockview's defaults. By injecting our overrides in useEffect,
  // we guarantee our <style> tag is appended to <head> AFTER dockview's.
  useEffect(() => {
    const styleId = 'dockview-ayu-overrides';
    // Avoid duplicate injection
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = DOCKVIEW_AYU_CSS;
    document.head.appendChild(style);

    return () => {
      style.remove();
    };
  }, []);

  // Handle right panel resize via mouse drag
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = rightPanelWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        setRightPanelWidth(startWidth + delta);
      };

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [rightPanelWidth, setRightPanelWidth]
  );

  useGlobalSearchShortcut();

  return (
    <div className="flex flex-col h-full w-full">
      <SearchPalette />
      {/* Toolbar */}
      {toolbarContent && (
        <div className="shrink-0 border-b bg-background z-10">
          {toolbarContent}
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 min-h-0 flex">
        {/* Activity Bar - VS Code style icon sidebar */}
        <div className="shrink-0 w-10 bg-secondary border-r border-border flex flex-col items-center pt-1 gap-0.5">
          <button
            onClick={toggleFileTree}
            className={`w-9 h-9 flex items-center justify-center rounded transition-colors ${
              isPanelOpen(PANEL_IDS.FILE_TREE)
                ? 'text-foreground bg-accent'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
            title="文件管理器"
          >
            <FolderOpen className="h-[18px] w-[18px]" />
          </button>
          <button
            onClick={toggleGitPanel}
            className={`w-9 h-9 flex items-center justify-center rounded transition-colors ${
              isPanelOpen(PANEL_IDS.GIT)
                ? 'text-foreground bg-accent'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
            title="Git 管理器"
          >
            <GitBranch className="h-[18px] w-[18px]" />
          </button>
          <button
            onClick={toggleSearchPanel}
            className={`w-9 h-9 flex items-center justify-center rounded transition-colors ${
              isPanelOpen(PANEL_IDS.SEARCH)
                ? 'text-foreground bg-accent'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
            title="搜索 (Ctrl+Shift+F)"
          >
            <Search className="h-[18px] w-[18px]" />
          </button>
        </div>

        {/* Dockview + Kanban overlay area */}
        <div className="flex-1 min-w-0 relative">
          {/* Dockview always mounted to preserve state */}
          <div className={activeTab === 'kanban' ? 'invisible h-full' : 'h-full'}>
            <DockviewReact
              components={panelComponents}
              onReady={handleReady}
              className="dockview-theme-light dockview-theme-ayu"
              rightHeaderActionsComponent={TerminalHeaderActions}
              disableFloatingGroups={true}
            />
          </div>
          {/* Kanban overlay when kanban tab is active */}
          {activeTab === 'kanban' && (
            <div className="absolute inset-0 z-10">
              <KanbanBoard />
            </div>
          )}
        </div>

        {/* Right fixed panel (AI Chat) - not part of dockview */}
        {isRightPanelVisible && rightPanelContent && (
          <>
            {/* Resize handle */}
            <div
              ref={resizeHandleRef}
              className="w-1 shrink-0 bg-border hover:bg-primary/30 cursor-col-resize transition-colors"
              onMouseDown={handleResizeMouseDown}
            />
            {/* Right panel container */}
            <div
              className="shrink-0 min-h-0 overflow-hidden border-l bg-background"
              style={{ width: rightPanelWidth }}
            >
              {rightPanelContent}
            </div>
          </>
        )}
      </div>
      {/* Status bar */}
      <StatusBar />
    </div>
  );
}
