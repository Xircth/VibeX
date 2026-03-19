import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from 'dockview-react';
import type { DockviewWillShowOverlayLocationEvent } from 'dockview-core';
import { FolderOpen, GitBranch, Search } from 'lucide-react';
import { panelComponents } from '@/components/layout/panels/PanelRegistry';
import { TerminalHeaderActions } from '@/components/layout/panels/TerminalHeaderActions';
import { StatusBar } from '@/components/layout/StatusBar';
import {
  EDITOR_GROUP_PREFIX,
  GROUP_IDS,
  MAX_EDITOR_GROUPS,
  PANEL_IDS,
  useLayoutStore,
} from '@/stores/useLayoutStore';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { applyLeftGroupHeaderHiding } from '@/utils/dockviewHelpers';
import { KanbanBoard } from '@/components/panels/DockviewKanbanPanel';
import { DEFAULT_TERMINAL_PANEL_HEIGHT } from '@/lib/terminalPreferences';
import { SearchPalette } from '@/components/search/SearchPalette';
import { useGlobalSearchShortcut } from '@/hooks/useGlobalSearchShortcut';
import DOCKVIEW_AYU_CSS from '@/styles/dockview-ayu.css?raw';

const LEFT_PANEL_IDS: ReadonlySet<string> = new Set([
  PANEL_IDS.FILE_TREE,
  PANEL_IDS.GIT,
  PANEL_IDS.SEARCH,
]);

const BOTTOM_PANEL_IDS: ReadonlySet<string> = new Set([PANEL_IDS.TERMINAL]);
const PLACEHOLDER_PANEL_IDS: ReadonlySet<string> = new Set([PANEL_IDS.WELCOME]);

const LAYOUT = {
  LEFT_PANEL_DEFAULT_WIDTH: 220,
  LEFT_PANEL_MIN_WIDTH: 200,
  LEFT_PANEL_MAX_RATIO: 0.4,
  LAYOUT_RESTORE_DELAY_MS: 100,
  DEFAULT_SIZE_RETRIES: 15,
  LAYOUT_CHANGE_DEBOUNCE_MS: 500,
  IDLE_PERSIST_TIMEOUT_MS: 1000,
} as const;

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

function isLeftGroup(group: DockviewGroup): boolean {
  return (
    group.id === GROUP_IDS.LEFT ||
    group.panels.some((panel) => LEFT_PANEL_IDS.has(panel.id))
  );
}

function isBottomGroup(group: DockviewGroup): boolean {
  return (
    group.id === GROUP_IDS.BOTTOM ||
    group.panels.some((panel) => BOTTOM_PANEL_IDS.has(panel.id))
  );
}

function isEditorGroup(group: DockviewGroup): boolean {
  return !isLeftGroup(group) && !isBottomGroup(group);
}

function isSplittableEditorPanel(panel: DockviewPanel): boolean {
  return isEditorGroup(panel.group) && !PLACEHOLDER_PANEL_IDS.has(panel.id);
}

function getGroupElement(group: DockviewGroup): HTMLElement | null {
  const value = group as unknown as { element?: HTMLElement };
  return value.element ?? null;
}

function compareEditorGroups(a: DockviewGroup, b: DockviewGroup): number {
  const aRect = getGroupElement(a)?.getBoundingClientRect();
  const bRect = getGroupElement(b)?.getBoundingClientRect();

  if (aRect && bRect) {
    if (Math.abs(aRect.left - bRect.left) > 1) {
      return aRect.left - bRect.left;
    }

    if (Math.abs(aRect.top - bRect.top) > 1) {
      return aRect.top - bRect.top;
    }
  }

  return a.id.localeCompare(b.id);
}

function getLeftGroup(api: DockviewApi): DockviewGroup | undefined {
  return api.getGroup(GROUP_IDS.LEFT) ?? api.groups.find((group) => isLeftGroup(group));
}

function getBottomGroup(api: DockviewApi): DockviewGroup | undefined {
  return (
    api.getGroup(GROUP_IDS.BOTTOM) ?? api.groups.find((group) => isBottomGroup(group))
  );
}

function getEditorGroups(api: DockviewApi): DockviewGroup[] {
  return api.groups.filter((group) => isEditorGroup(group)).sort(compareEditorGroups);
}

function getNextEditorGroupId(api: DockviewApi): string {
  const ids = new Set(api.groups.map((group) => group.id));
  let index = 1;

  while (ids.has(`${EDITOR_GROUP_PREFIX}${index}`)) {
    index += 1;
  }

  return `${EDITOR_GROUP_PREFIX}${index}`;
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
  }

  applyLeftGroupHeaderHiding(api);
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
    initialWidth: LAYOUT.LEFT_PANEL_DEFAULT_WIDTH,
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

  const leftGroup = getLeftGroup(api);
  const referencePanel =
    leftGroup?.panels[0] ?? api.panels.find((panel) => !BOTTOM_PANEL_IDS.has(panel.id));

  const welcomePanel = api.addPanel({
    id: PANEL_IDS.WELCOME,
    component: PANEL_IDS.WELCOME,
    title: 'Welcome',
    ...(referencePanel
      ? {
          position: {
            referencePanel,
            direction: leftGroup ? 'right' : 'within',
          } as const,
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

export function IDELayout({ rightPanelContent, toolbarContent }: IDELayoutProps) {
  const apiRef = useRef<DockviewApi | null>(null);
  const dockviewRootRef = useRef<HTMLDivElement>(null);
  const tabContextMenuRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const { activeWorktreeId } = useWorktree();
  const {
    serializedLayout,
    setSerializedLayout,
    isRightPanelVisible,
    rightPanelWidth,
    setRightPanelWidth,
    activeTab,
  } = useLayoutStore();
  const serializedLayoutRef = useRef(serializedLayout);
  const layoutChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isResettingRef = useRef(false);
  const isClampingRef = useRef(false);
  const prevSerializedLayoutRef = useRef(serializedLayout);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(
    null
  );

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

  const applyDefaultSizes = useCallback(
    (
      api: DockviewApi,
      retries: number = LAYOUT.DEFAULT_SIZE_RETRIES,
      onDone?: () => void
    ) => {
      if (api.width <= 0 && retries > 0) {
        requestAnimationFrame(() => applyDefaultSizes(api, retries - 1, onDone));
        return;
      }

      try {
        const leftGroup = getLeftGroup(api);
        if (leftGroup?.api.isVisible) {
          leftGroup.api.setSize({ width: LAYOUT.LEFT_PANEL_DEFAULT_WIDTH });
        }

        const bottomGroup = getBottomGroup(api);
        if (bottomGroup?.api.isVisible) {
          bottomGroup.api.setSize({ height: DEFAULT_TERMINAL_PANEL_HEIGHT });
        }
      } catch {
        // Ignore sizing errors during layout transitions.
      }

      onDone?.();
    },
    []
  );

  const clampPanelWidths = useCallback((api: DockviewApi) => {
    if (isClampingRef.current) return;

    isClampingRef.current = true;
    try {
      if (api.width <= 0) return;

      const leftGroup = getLeftGroup(api);
      if (!leftGroup?.api.isVisible) return;

      const maxLeftWidth = api.width * LAYOUT.LEFT_PANEL_MAX_RATIO;
      if (
        leftGroup.api.width > maxLeftWidth &&
        maxLeftWidth > LAYOUT.LEFT_PANEL_MIN_WIDTH
      ) {
        leftGroup.api.setSize({ width: maxLeftWidth });
      }
    } catch {
      // Ignore clamp failures during intermediate layout changes.
    } finally {
      isClampingRef.current = false;
    }
  }, []);

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
    [applyDefaultSizes, setSerializedLayout]
  );

  const ensureWorkspacePanelsVisible = useCallback(
    (api: DockviewApi) => {
      if (!activeWorktreeId) return;

      let leftGroup = getLeftGroup(api);
      if (!leftGroup) {
        const editorGroup = getEditorGroups(api)[0] ?? ensureWelcomeEditorGroup(api);
        const referencePanel = editorGroup?.panels[0];
        if (!referencePanel) return;

        leftGroup = api.addGroup({
          id: GROUP_IDS.LEFT,
          referencePanel,
          direction: 'left',
          hideHeader: true,
          initialWidth: LAYOUT.LEFT_PANEL_DEFAULT_WIDTH,
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
      if (!bottomGroup) {
        const editorGroup = getEditorGroups(api)[0] ?? ensureWelcomeEditorGroup(api);
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

      bottomGroup.api.setVisible(true);
      normalizeGroupIds(api);
    },
    [activeWorktreeId]
  );

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
      const isSourceEditorPanel = !isSourceLeftPanel && !isSourceBottomPanel;
      const isTargetLeftGroup = isLeftGroup(targetGroup);
      const isTargetBottomGroup = isBottomGroup(targetGroup);
      const isTargetEditorGroup = isEditorGroup(targetGroup);

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
      if (layout) {
        try {
          api.fromJSON(layout);
          normalizeGroupIds(api);
        } catch (error) {
          console.warn('Failed to restore dockview layout, rebuilding default.', error);
          rebuildDefaultLayout(api, false);
        }
      } else {
        buildDefaultLayout(api);
        requestAnimationFrame(() => applyDefaultSizes(api));
      }

      ensureWorkspacePanelsVisible(api);

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
          clampPanelWidths(api);

          const persistLayout = () => {
            try {
              setSerializedLayout(api.toJSON());
            } catch {
              // Ignore serialization failures during transient layout states.
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
      applyDefaultSizes,
      clampPanelWidths,
      ensureWorkspacePanelsVisible,
      rebuildDefaultLayout,
      registerDndGuard,
      setDockviewApi,
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
    if (!api || !activeWorktreeId) return;

    const frame = requestAnimationFrame(() => {
      try {
        ensureWorkspacePanelsVisible(api);
      } catch (error) {
        console.warn('Failed to restore workspace panels, rebuilding layout.', error);
        rebuildDefaultLayout(api);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [activeWorktreeId, ensureWorkspacePanelsVisible, rebuildDefaultLayout]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api || activeWorktreeId) return;

    const bottomGroup = getBottomGroup(api);
    if (bottomGroup) {
      bottomGroup.api.setVisible(false);
    }
  }, [activeWorktreeId]);

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

  const handleResizeMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();

      const startX = event.clientX;
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
    <div className="flex h-full w-full flex-col">
      <SearchPalette />
      {toolbarContent && (
        <div className="z-10 shrink-0 border-b bg-background">{toolbarContent}</div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 border-r border-border bg-secondary pt-1">
          <button
            onClick={toggleFileTree}
            className={`flex h-9 w-9 items-center justify-center rounded transition-colors ${
              isPanelOpen(PANEL_IDS.FILE_TREE)
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
            title="Files"
          >
            <FolderOpen className="h-[18px] w-[18px]" />
          </button>
          <button
            onClick={toggleGitPanel}
            className={`flex h-9 w-9 items-center justify-center rounded transition-colors ${
              isPanelOpen(PANEL_IDS.GIT)
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
            title="Git"
          >
            <GitBranch className="h-[18px] w-[18px]" />
          </button>
          <button
            onClick={toggleSearchPanel}
            className={`flex h-9 w-9 items-center justify-center rounded transition-colors ${
              isPanelOpen(PANEL_IDS.SEARCH)
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
            title="Search (Ctrl+Shift+F)"
          >
            <Search className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="relative flex-1 min-w-0" ref={dockviewRootRef}>
          <div className={activeTab === 'kanban' ? 'invisible h-full' : 'h-full'}>
            <DockviewReact
              components={panelComponents}
              onReady={handleReady}
              className="dockview-theme-light dockview-theme-ayu"
              rightHeaderActionsComponent={TerminalHeaderActions}
              disableFloatingGroups={true}
            />
          </div>

          {activeTab === 'kanban' && (
            <div className="absolute inset-0 z-10">
              <KanbanBoard />
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
                disabled={!canOpenPanelInNewEditorGroup(tabContextMenu.panelId)}
                onClick={() => {
                  openPanelInNewEditorGroup(tabContextMenu.panelId);
                  setTabContextMenu(null);
                }}
              >
                在新的编辑区打开
              </button>
            </div>
          )}
        </div>

        {isRightPanelVisible && rightPanelContent && (
          <>
            <div
              ref={resizeHandleRef}
              className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/30"
              onMouseDown={handleResizeMouseDown}
            />
            <div
              className="shrink-0 overflow-hidden bg-background"
              style={{ width: rightPanelWidth }}
            >
              {rightPanelContent}
            </div>
          </>
        )}
      </div>

      <StatusBar />
    </div>
  );
}
