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

/**
 * Dockview Ayu theme CSS overrides.
 *
 * IMPORTANT: This CSS is injected at runtime via useEffect rather than imported
 * as a CSS file. The reason is that dockview-react's ESM bundle embeds its own
 * CSS and injects it via `styleInject()` when the module is first imported.
 * This injected <style> tag ends up AFTER any Vite-processed CSS imports in the
 * <head>, which means dockview's built-in `.dockview-theme-light` variable
 * definitions override our custom theme variables (same specificity, later wins).
 *
 * By injecting our overrides in a useEffect (which runs after all module-level
 * side effects including styleInject), we guarantee our <style> tag is the last
 * one in <head>, ensuring our variables and !important rules take precedence.
 */
const DOCKVIEW_AYU_CSS = `
/* Ayu Light: override built-in dockview-theme-light variables */
.dockview-theme-light.dockview-theme-ayu,
.dockview-theme-ayu.dockview-theme-light,
.dockview-theme-ayu {
  --dv-paneview-active-outline-color: #5B8CC7;
  --dv-tabs-and-actions-container-font-size: 12px;
  --dv-tabs-and-actions-container-height: 35px;
  --dv-drag-over-background-color: rgba(91, 140, 199, 0.1);
  --dv-drag-over-border-color: #5B8CC7;
  --dv-tabs-container-scrollbar-color: #D4D4D5;
  --dv-icon-hover-background-color: rgba(91, 140, 199, 0.15);
  --dv-floating-box-shadow: 8px 8px 8px 0px rgba(0, 0, 0, 0.1);
  --dv-overlay-z-index: 999;
  --dv-tab-font-size: inherit;
  --dv-border-radius: 0px;
  --dv-tab-margin: 0;
  --dv-sash-color: transparent;
  --dv-active-sash-color: transparent;
  --dv-active-sash-transition-duration: 0.1s;
  --dv-active-sash-transition-delay: 0.5s;
  --dv-scrollbar-background-color: rgba(0, 0, 0, 0.1);
  --dv-activegroup-visiblepanel-tab-background-color: #FAFAFA;
  --dv-activegroup-hiddenpanel-tab-background-color: #F0F0F0;
  --dv-inactivegroup-visiblepanel-tab-background-color: #F0F0F0;
  --dv-inactivegroup-hiddenpanel-tab-background-color: #E7E8E9;
  --dv-tab-divider-color: #E1E1E2;
  --dv-activegroup-visiblepanel-tab-color: #242936;
  --dv-activegroup-hiddenpanel-tab-color: #8A9199;
  --dv-inactivegroup-visiblepanel-tab-color: #5C6166;
  --dv-inactivegroup-hiddenpanel-tab-color: #8A9199;
  --dv-background-color: #F0F0F0;
  --dv-paneview-header-border-color: #E1E1E2;
  --dv-tabs-and-actions-container-background-color: #F0F0F0;
  --dv-group-view-background-color: #FAFAFA;
  --dv-separator-border: #E1E1E2;
}

/* Hard override: force light backgrounds on ALL dockview structural elements */
[class*="dockview-theme-ayu"] .dv-tabs-and-actions-container {
  background-color: #F0F0F0 !important;
}
[class*="dockview-theme-ayu"] .dv-content-container {
  background-color: #FAFAFA !important;
}
[class*="dockview-theme-ayu"] .dv-groupview {
  background-color: #FAFAFA !important;
}
[class*="dockview-theme-ayu"].dv-dockview,
.dv-dockview[class*="dockview-theme-ayu"] {
  background-color: #FAFAFA !important;
}
[class*="dockview-theme-ayu"] .dv-tab.dv-active-tab {
  color: #242936 !important;
}
[class*="dockview-theme-ayu"] .dv-tab.dv-inactive-tab {
  color: #8A9199 !important;
}
[class*="dockview-theme-ayu"] .dv-void-container {
  background-color: #F0F0F0 !important;
}

/* Ayu Mirage dockview theme (dark mode) */
.dark .dockview-theme-light.dockview-theme-ayu,
.dark .dockview-theme-ayu.dockview-theme-light,
.dark .dockview-theme-ayu {
  --dv-paneview-active-outline-color: #5B8CC7;
  --dv-icon-hover-background-color: rgba(91, 140, 199, 0.2);
  --dv-floating-box-shadow: 8px 8px 8px 0px rgba(0, 0, 0, 0.4);
  --dv-scrollbar-background-color: rgba(255, 255, 255, 0.15);
  --dv-activegroup-visiblepanel-tab-background-color: #1F2430;
  --dv-activegroup-hiddenpanel-tab-background-color: #232834;
  --dv-inactivegroup-visiblepanel-tab-background-color: #232834;
  --dv-inactivegroup-hiddenpanel-tab-background-color: #2A2F3A;
  --dv-tab-divider-color: #2A2F3A;
  --dv-activegroup-visiblepanel-tab-color: #E0E0E0;
  --dv-activegroup-hiddenpanel-tab-color: #5C6773;
  --dv-inactivegroup-visiblepanel-tab-color: #B8C4D0;
  --dv-inactivegroup-hiddenpanel-tab-color: #5C6773;
  --dv-background-color: #232834;
  --dv-paneview-header-border-color: #2A2F3A;
  --dv-tabs-and-actions-container-background-color: #232834;
  --dv-tabs-container-scrollbar-color: #3B4252;
  --dv-group-view-background-color: #1F2430;
  --dv-separator-border: #2A2F3A;
  --dv-drag-over-background-color: rgba(91, 140, 199, 0.15);
  --dv-drag-over-border-color: #5B8CC7;
}
.dark [class*="dockview-theme-ayu"] .dv-tabs-and-actions-container {
  background-color: #232834 !important;
}
.dark [class*="dockview-theme-ayu"] .dv-content-container {
  background-color: #1F2430 !important;
}
.dark [class*="dockview-theme-ayu"] .dv-groupview {
  background-color: #1F2430 !important;
}
.dark [class*="dockview-theme-ayu"].dv-dockview,
.dark .dv-dockview[class*="dockview-theme-ayu"] {
  background-color: #1F2430 !important;
}
.dark [class*="dockview-theme-ayu"] .dv-tab.dv-active-tab {
  color: #E0E0E0 !important;
}
.dark [class*="dockview-theme-ayu"] .dv-tab.dv-inactive-tab {
  color: #5C6773 !important;
}
.dark [class*="dockview-theme-ayu"] .dv-void-container {
  background-color: #232834 !important;
}

/* Hide tab header for groups marked with dv-header-hidden class (e.g. left sidebar) */
.dv-header-hidden > .dv-tabs-and-actions-container {
  display: none !important;
}

/* Allow tab bar to scroll horizontally when tabs overflow, instead of hiding them */
[class*="dockview-theme-ayu"] .dv-scrollable > .dv-tabs-container {
  overflow-x: auto !important;
  overflow-y: hidden !important;
  scrollbar-width: thin;
}
[class*="dockview-theme-ayu"] .dv-scrollable > .dv-tabs-container::-webkit-scrollbar {
  height: 3px;
}
[class*="dockview-theme-ayu"] .dv-scrollable > .dv-tabs-container::-webkit-scrollbar-thumb {
  background-color: var(--dv-tabs-container-scrollbar-color, rgba(0,0,0,0.2));
  border-radius: 2px;
}
`;

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
      initialWidth: 300,
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

  const normalizeCanonicalGroupIds = useCallback((api: DockviewApi) => {
    const leftGroup = api.groups.find((group) =>
      group.panels.some(
        (panel) => panel.id === PANEL_IDS.FILE_TREE || panel.id === PANEL_IDS.GIT
      )
    );
    if (leftGroup) {
      (leftGroup as { id: string }).id = GROUP_IDS.LEFT;
    }

    const bottomGroup = api.groups.find((group) =>
      group.panels.some((panel) => panel.id === PANEL_IDS.TERMINAL)
    );
    if (bottomGroup) {
      (bottomGroup as { id: string }).id = GROUP_IDS.BOTTOM;
      bottomGroup.locked = 'no-drop-target';
    }

    const center1Group = api.getPanel(PANEL_IDS.WELCOME)?.group;
    if (center1Group) {
      (center1Group as { id: string }).id = GROUP_IDS.CENTER_1;
    }

    const center2Group = api.getPanel(`${PANEL_IDS.WELCOME}-2`)?.group;
    if (center2Group) {
      (center2Group as { id: string }).id = GROUP_IDS.CENTER_2;
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
  const validateTerminalPosition = useCallback((api: DockviewApi) => {
    const terminalPanel = api.getPanel(PANEL_IDS.TERMINAL);
    if (!terminalPanel) return;

    const termGroup = terminalPanel.group;
    const isInBottomGroup = termGroup.id === GROUP_IDS.BOTTOM;

    if (isInBottomGroup) {
      termGroup.locked = 'no-drop-target';
      return;
    }

    api.removePanel(terminalPanel);

    let bottomGroup = api.getGroup(GROUP_IDS.BOTTOM);
    if (!bottomGroup) {
      const centerGroups = api.groups.filter((g) => {
        const ids = g.panels.map((p) => p.id);
        const isLeft = ids.some(
          (id) => id === PANEL_IDS.FILE_TREE || id === PANEL_IDS.GIT
        );
        const isBottom = ids.some((id) => id === PANEL_IDS.TERMINAL);
        return !isLeft && !isBottom;
      });
      const refPanel = centerGroups[0]?.panels[0];
      if (!refPanel) {
        return;
      }
      bottomGroup = api.addGroup({
        id: GROUP_IDS.BOTTOM,
        referencePanel: refPanel,
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
  }, []);

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
        const maxLeftWidth = containerWidth * 0.4;
        if (leftWidth > maxLeftWidth && maxLeftWidth > 200) {
          leftGroup.api.setSize({ width: maxLeftWidth });
        }
      }

      const terminalPanel = api.getPanel(PANEL_IDS.TERMINAL);
      if (terminalPanel) {
        const termGroup = terminalPanel.group;
        if (termGroup && termGroup.api.isVisible) {
          const termWidth = termGroup.api.width;
          const leftGroupWidth = leftGroup?.api.isVisible ? leftGroup.api.width : 0;
          const maxTermWidth = containerWidth - leftGroupWidth;
          if (termWidth > maxTermWidth + 2 && maxTermWidth > 0) {
            termGroup.api.setSize({ width: maxTermWidth });
          }
        }
      }
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
          referencePanel: centerRef,
          direction: 'left',
          hideHeader: true,
          initialWidth: 300,
        });
      }

      if (!api.getPanel(PANEL_IDS.FILE_TREE)) {
        api.addPanel({
          id: PANEL_IDS.FILE_TREE,
          component: PANEL_IDS.FILE_TREE,
          title: '文件管理器',
          position: {
            referenceGroup: leftGroup.id,
            direction: 'within',
          },
        });
      }
      leftGroup.api.setVisible(true);

      let bottomGroup = api.getGroup(GROUP_IDS.BOTTOM);
      if (!bottomGroup) {
        const centerRef = api.getPanel(PANEL_IDS.WELCOME) ?? api.panels[0];
        if (!centerRef) return;
        bottomGroup = api.addGroup({
          id: GROUP_IDS.BOTTOM,
          referencePanel: centerRef,
          direction: 'below',
          locked: 'no-drop-target',
          initialHeight: DEFAULT_TERMINAL_PANEL_HEIGHT,
        });
      }

      if (!api.getPanel(PANEL_IDS.TERMINAL)) {
        api.addPanel({
          id: PANEL_IDS.TERMINAL,
          component: PANEL_IDS.TERMINAL,
          title: 'Terminal',
          position: {
            referenceGroup: bottomGroup.id,
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
          const clampInitialWidths = (retries = 10) => {
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
          buildDefaultLayout(api);
          normalizeCanonicalGroupIds(api);
        }
      } else {
        buildDefaultLayout(api);
        normalizeCanonicalGroupIds(api);
      }

      // Register drag-drop guard to prevent panels from entering left sidebar
      const dndGuardDisposable = registerDndGuard(api);

      // Persist layout on changes and update activity bar state.
      // Debounce to avoid rapid-fire serialization and re-entrant clamp loops.
      const layoutDisposable = api.onDidLayoutChange(() => {
        if (layoutChangeTimerRef.current) {
          clearTimeout(layoutChangeTimerRef.current);
        }
        layoutChangeTimerRef.current = setTimeout(() => {
          layoutChangeTimerRef.current = null;
          try {
            setSerializedLayout(api.toJSON());
          } catch {
            // Ignore serialization errors during transitions
          }
          setLayoutVersion((v) => v + 1);
          clampPanelWidths(api);
        }, 100);
      });

      return () => {
        dndGuardDisposable.dispose();
        layoutDisposable.dispose();
        if (layoutChangeTimerRef.current) {
          clearTimeout(layoutChangeTimerRef.current);
        }
      };
    },
    [setSerializedLayout, buildDefaultLayout, normalizeCanonicalGroupIds, setDockviewApi, validateTerminalPosition, registerDndGuard, clampPanelWidths]
  );

  // Clean up API ref on unmount
  useEffect(() => {
    return () => {
      apiRef.current = null;
      setDockviewApi(null);
    };
  }, [setDockviewApi]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api || !activeWorktreeId) return;

    const frame = requestAnimationFrame(() => {
      ensureWorkspacePanelsVisible(api);
    });

    return () => cancelAnimationFrame(frame);
  }, [activeWorktreeId, ensureWorkspacePanelsVisible]);

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
