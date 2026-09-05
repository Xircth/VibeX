import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SerializedDockview } from 'dockview';
import { GLOBAL_PROJECT_SCOPE } from '@/lib/projectScope';
import { DEFAULT_SESSION_PANEL_WIDTH } from '@/utils/dockviewStartupSizing';

/**
 * Panel IDs used to register and identify panels in the dockview layout.
 */
export const PANEL_IDS = {
  KANBAN: 'kanban',
  FILE_TREE: 'file-tree',
  PREVIEW: 'preview',
  // Web Preview (built-in browser / dev-server preview). Renamed from
  // 'dev-preview'; persisted layouts are migrated in this store's `migrate`.
  WEB_PREVIEW: 'web-preview',
  DIFFS: 'diffs',
  TERMINAL: 'terminal',
  AI_CHAT: 'ai-chat',
  GIT: 'git',
  MERGE: 'merge',
  WELCOME: 'welcome',
  LOGS: 'logs',
  NOTES: 'notes',
  SEARCH: 'search',
  SESSION_LIST: 'session-list',
} as const;

export type PanelId = (typeof PANEL_IDS)[keyof typeof PANEL_IDS];

/**
 * Group IDs for organizing panels in the dockview layout.
 */
export const GROUP_IDS = {
  LEFT: 'group-left',
  BOTTOM: 'group-bottom',
  RIGHT: 'group-right',
} as const;

export type GroupId = (typeof GROUP_IDS)[keyof typeof GROUP_IDS];

export const EDITOR_GROUP_PREFIX = 'group-editor-';
export const MAX_EDITOR_GROUPS = 4;

export type WorkspaceTab = 'workspace' | 'kanban';

interface LayoutState {
  /** Current project scope key */
  currentProjectKey: string;

  /** Cached layout state per project */
  projectLayouts: Record<string, LayoutSnapshot>;

  /** Serialized dockview layout for persistence */
  serializedLayout: SerializedDockview | null;

  /** Whether the file tree sidebar is visible */
  isFileTreeVisible: boolean;

  /** Width of the right (AI chat) panel in pixels */
  rightPanelWidth: number;

  /** Width of the session slot on the kanban page in pixels */
  kanbanSessionWidth: number;

  /** Whether the right (AI chat) panel is visible */
  isRightPanelVisible: boolean;

  /** Whether the workspace editor/terminal area is visible */
  isEditorAreaVisible: boolean;

  /** Whether the Kanban session list is visible */
  isKanbanListVisible: boolean;

  /** Whether the Kanban session monitor is visible */
  isKanbanMonitorVisible: boolean;

  /** Whether the Kanban session execution area is visible */
  isKanbanSessionVisible: boolean;

  /** Active tab: workspace or kanban */
  activeTab: WorkspaceTab;

  /** Actions */
  setCurrentProject: (projectKey: string) => void;
  setSerializedLayout: (layout: SerializedDockview | null) => void;
  toggleFileTree: () => void;
  setFileTreeVisible: (visible: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  setKanbanSessionWidth: (width: number) => void;
  toggleRightPanel: () => void;
  setRightPanelVisible: (visible: boolean) => void;
  toggleEditorArea: () => void;
  setEditorAreaVisible: (visible: boolean) => void;
  toggleKanbanList: () => void;
  setKanbanListVisible: (visible: boolean) => void;
  toggleKanbanMonitor: () => void;
  setKanbanMonitorVisible: (visible: boolean) => void;
  toggleKanbanSession: () => void;
  setKanbanSessionVisible: (visible: boolean) => void;
  setActiveTab: (tab: WorkspaceTab) => void;
  setProjectActiveTab: (projectKey: string, tab: WorkspaceTab) => void;
  resetLayout: () => void;
  resetKanbanLayout: () => void;
}

// Previous default was 620px; 434px is exactly 30% smaller. This is only the
// seed for new/reset project snapshots and never overwrites a persisted drag.
const DEFAULT_RIGHT_PANEL_WIDTH = DEFAULT_SESSION_PANEL_WIDTH;
const DEFAULT_KANBAN_SESSION_WIDTH = 520;
/** Exported so the workspace dockview can self-heal a crushed session column. */
export const MIN_RIGHT_PANEL_WIDTH = 400;
const MAX_RIGHT_PANEL_WIDTH = 900;

export interface LayoutSnapshot {
  serializedLayout: SerializedDockview | null;
  isFileTreeVisible: boolean;
  rightPanelWidth: number;
  kanbanSessionWidth: number;
  isRightPanelVisible: boolean;
  isEditorAreaVisible: boolean;
  isKanbanListVisible: boolean;
  isKanbanMonitorVisible: boolean;
  isKanbanSessionVisible: boolean;
  activeTab: WorkspaceTab;
}

const DEFAULT_LAYOUT_SNAPSHOT: LayoutSnapshot = {
  serializedLayout: null,
  isFileTreeVisible: true,
  rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
  kanbanSessionWidth: DEFAULT_KANBAN_SESSION_WIDTH,
  isRightPanelVisible: true,
  isEditorAreaVisible: true,
  isKanbanListVisible: true,
  isKanbanMonitorVisible: true,
  isKanbanSessionVisible: true,
  activeTab: 'kanban',
};

function clampSessionWidth(width: number): number {
  return Math.max(
    MIN_RIGHT_PANEL_WIDTH,
    Math.min(MAX_RIGHT_PANEL_WIDTH, width)
  );
}

/**
 * Sanitize a persisted session width. Values above the maximum are treated
 * as corrupted (an interim build briefly synced the flexible center-slot
 * remainder into this preference) and reset to the given default.
 */
function sanitizeSessionWidth(
  width: number | null | undefined,
  defaultWidth: number
): number {
  if (width == null || width === 420 || width === 500) {
    return defaultWidth;
  }
  if (width > MAX_RIGHT_PANEL_WIDTH) {
    return defaultWidth;
  }
  return clampSessionWidth(width);
}

function buildProjectLayoutState(
  partial?: Partial<LayoutSnapshot> | null
): LayoutSnapshot {
  return {
    ...DEFAULT_LAYOUT_SNAPSHOT,
    ...partial,
    rightPanelWidth: sanitizeSessionWidth(
      partial?.rightPanelWidth,
      DEFAULT_RIGHT_PANEL_WIDTH
    ),
    kanbanSessionWidth: sanitizeSessionWidth(
      partial?.kanbanSessionWidth,
      DEFAULT_KANBAN_SESSION_WIDTH
    ),
  };
}

function getCurrentSnapshot(state: LayoutState): LayoutSnapshot {
  return {
    serializedLayout: state.serializedLayout,
    isFileTreeVisible: state.isFileTreeVisible,
    rightPanelWidth: state.rightPanelWidth,
    kanbanSessionWidth: state.kanbanSessionWidth,
    isRightPanelVisible: state.isRightPanelVisible,
    isEditorAreaVisible: state.isEditorAreaVisible,
    isKanbanListVisible: state.isKanbanListVisible,
    isKanbanMonitorVisible: state.isKanbanMonitorVisible,
    isKanbanSessionVisible: state.isKanbanSessionVisible,
    activeTab: state.activeTab,
  };
}

/**
 * v22 rename: the Web Preview panel id changed from 'dev-preview' to
 * 'web-preview'. Serialized dockview layouts reference the id in several
 * places (panels map keys, panel ids, contentComponent, group views /
 * activeView), so rewrite every exact "dev-preview" string value. Quoted
 * matching keeps longer strings (titles, file paths) untouched.
 */
function renameWebPreviewPanelId(
  layout: SerializedDockview | null
): SerializedDockview | null {
  if (!layout) return layout;
  try {
    const json = JSON.stringify(layout);
    if (!json.includes('"dev-preview"')) return layout;
    return JSON.parse(
      json.replaceAll('"dev-preview"', '"web-preview"')
    ) as SerializedDockview;
  } catch {
    return layout;
  }
}

function applySnapshot(nextSnapshot: LayoutSnapshot): Partial<LayoutState> {
  return {
    serializedLayout: nextSnapshot.serializedLayout,
    isFileTreeVisible: nextSnapshot.isFileTreeVisible,
    rightPanelWidth: nextSnapshot.rightPanelWidth,
    kanbanSessionWidth: nextSnapshot.kanbanSessionWidth,
    isRightPanelVisible: nextSnapshot.isRightPanelVisible,
    isEditorAreaVisible: nextSnapshot.isEditorAreaVisible,
    isKanbanListVisible: nextSnapshot.isKanbanListVisible,
    isKanbanMonitorVisible: nextSnapshot.isKanbanMonitorVisible,
    isKanbanSessionVisible: nextSnapshot.isKanbanSessionVisible,
    activeTab: nextSnapshot.activeTab,
  };
}

export interface MigratedLayoutState extends LayoutSnapshot {
  currentProjectKey: string;
  projectLayouts: Record<string, LayoutSnapshot>;
}

/**
 * Upgrade persisted per-project layout snapshots.
 *
 * Persisted widths always represent user choices. Default-width changes apply
 * only when a project has no snapshot yet; migrations must not infer intent
 * from a pixel value that a user may also have selected by dragging.
 */
export function migratePersistedLayoutState(
  persistedState: unknown,
  version: number
): MigratedLayoutState {
  const state = (persistedState ?? {}) as Partial<LayoutState>;
  const legacySnapshot = buildProjectLayoutState({
    serializedLayout: null,
    isFileTreeVisible: state.isFileTreeVisible,
    rightPanelWidth: state.rightPanelWidth,
    isRightPanelVisible: state.isRightPanelVisible,
    isEditorAreaVisible: state.isEditorAreaVisible,
    activeTab: state.activeTab,
  });
  const currentProjectKey = state.currentProjectKey ?? GLOBAL_PROJECT_SCOPE;
  const projectLayouts = Object.entries(state.projectLayouts ?? {}).reduce<
    Record<string, LayoutSnapshot>
  >((accumulator, [projectKey, projectState]) => {
    accumulator[projectKey] = buildProjectLayoutState(projectState);

    // One-time reset for v<21 snapshots: interim builds persisted corrupted
    // zone sizes, so rebuild the grid with fresh defaults (panel sizes only;
    // visibility flags and tabs are kept).
    if (version < 21) {
      accumulator[projectKey].serializedLayout = null;
    } else if (version < 22) {
      // v22: Web Preview panel id renamed from 'dev-preview'.
      accumulator[projectKey].serializedLayout = renameWebPreviewPanelId(
        accumulator[projectKey].serializedLayout
      );
    }
    // v23: zone defaults became percentage-based and restores became
    // verbatim. Reset older grids so startup scaling artifacts do not persist.
    if (version < 23) {
      accumulator[projectKey].serializedLayout = null;
    }
    // v24: Dockview now owns A/C zone minimum-width constraints.
    if (version < 24) {
      accumulator[projectKey].serializedLayout = null;
    }
    return accumulator;
  }, {});

  if (!projectLayouts[currentProjectKey]) {
    projectLayouts[currentProjectKey] = legacySnapshot;
  }

  const activeSnapshot = buildProjectLayoutState(
    projectLayouts[currentProjectKey]
  );

  return {
    currentProjectKey,
    projectLayouts,
    ...activeSnapshot,
  };
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      currentProjectKey: GLOBAL_PROJECT_SCOPE,
      projectLayouts: {
        [GLOBAL_PROJECT_SCOPE]: DEFAULT_LAYOUT_SNAPSHOT,
      },
      ...DEFAULT_LAYOUT_SNAPSHOT,

      setCurrentProject: (projectKey) =>
        set((state) => {
          if (state.currentProjectKey === projectKey) {
            return state;
          }

          const currentSnapshot = getCurrentSnapshot(state);
          const projectLayouts = {
            ...state.projectLayouts,
            [state.currentProjectKey]: currentSnapshot,
          };
          const nextSnapshot = buildProjectLayoutState(
            projectLayouts[projectKey]
          );

          return {
            currentProjectKey: projectKey,
            projectLayouts,
            ...applySnapshot(nextSnapshot),
          };
        }),

      setSerializedLayout: (layout) =>
        set((state) => ({
          serializedLayout: layout,
          projectLayouts: {
            ...state.projectLayouts,
            [state.currentProjectKey]: {
              ...getCurrentSnapshot(state),
              serializedLayout: layout,
            },
          },
        })),

      toggleFileTree: () =>
        set((state) => {
          const nextValue = !state.isFileTreeVisible;
          return {
            isFileTreeVisible: nextValue,
            projectLayouts: {
              ...state.projectLayouts,
              [state.currentProjectKey]: {
                ...getCurrentSnapshot(state),
                isFileTreeVisible: nextValue,
              },
            },
          };
        }),

      setFileTreeVisible: (visible) =>
        set((state) => ({
          isFileTreeVisible: visible,
          projectLayouts: {
            ...state.projectLayouts,
            [state.currentProjectKey]: {
              ...getCurrentSnapshot(state),
              isFileTreeVisible: visible,
            },
          },
        })),

      setRightPanelWidth: (width) =>
        set((state) => {
          const nextWidth = clampSessionWidth(width);

          return {
            rightPanelWidth: nextWidth,
            projectLayouts: {
              ...state.projectLayouts,
              [state.currentProjectKey]: {
                ...getCurrentSnapshot(state),
                rightPanelWidth: nextWidth,
              },
            },
          };
        }),

      setKanbanSessionWidth: (width) =>
        set((state) => {
          const nextWidth = clampSessionWidth(width);

          return {
            kanbanSessionWidth: nextWidth,
            projectLayouts: {
              ...state.projectLayouts,
              [state.currentProjectKey]: {
                ...getCurrentSnapshot(state),
                kanbanSessionWidth: nextWidth,
              },
            },
          };
        }),

      toggleRightPanel: () =>
        set((state) => {
          const nextVisible = !state.isRightPanelVisible;
          return {
            isRightPanelVisible: nextVisible,
            projectLayouts: {
              ...state.projectLayouts,
              [state.currentProjectKey]: {
                ...getCurrentSnapshot(state),
                isRightPanelVisible: nextVisible,
              },
            },
          };
        }),

      setRightPanelVisible: (visible) =>
        set((state) => ({
          isRightPanelVisible: visible,
          projectLayouts: {
            ...state.projectLayouts,
            [state.currentProjectKey]: {
              ...getCurrentSnapshot(state),
              isRightPanelVisible: visible,
            },
          },
        })),

      toggleEditorArea: () =>
        set((state) => {
          const nextValue = !state.isEditorAreaVisible;
          return {
            isEditorAreaVisible: nextValue,
            projectLayouts: {
              ...state.projectLayouts,
              [state.currentProjectKey]: {
                ...getCurrentSnapshot(state),
                isEditorAreaVisible: nextValue,
              },
            },
          };
        }),

      setEditorAreaVisible: (visible) =>
        set((state) => ({
          isEditorAreaVisible: visible,
          projectLayouts: {
            ...state.projectLayouts,
            [state.currentProjectKey]: {
              ...getCurrentSnapshot(state),
              isEditorAreaVisible: visible,
            },
          },
        })),

      toggleKanbanList: () =>
        set((state) => {
          const nextValue = !state.isKanbanListVisible;
          return {
            isKanbanListVisible: nextValue,
            projectLayouts: {
              ...state.projectLayouts,
              [state.currentProjectKey]: {
                ...getCurrentSnapshot(state),
                isKanbanListVisible: nextValue,
              },
            },
          };
        }),

      setKanbanListVisible: (visible) =>
        set((state) => ({
          isKanbanListVisible: visible,
          projectLayouts: {
            ...state.projectLayouts,
            [state.currentProjectKey]: {
              ...getCurrentSnapshot(state),
              isKanbanListVisible: visible,
            },
          },
        })),

      toggleKanbanMonitor: () =>
        set((state) => {
          const nextValue = !state.isKanbanMonitorVisible;
          return {
            isKanbanMonitorVisible: nextValue,
            projectLayouts: {
              ...state.projectLayouts,
              [state.currentProjectKey]: {
                ...getCurrentSnapshot(state),
                isKanbanMonitorVisible: nextValue,
              },
            },
          };
        }),

      setKanbanMonitorVisible: (visible) =>
        set((state) => ({
          isKanbanMonitorVisible: visible,
          projectLayouts: {
            ...state.projectLayouts,
            [state.currentProjectKey]: {
              ...getCurrentSnapshot(state),
              isKanbanMonitorVisible: visible,
            },
          },
        })),

      toggleKanbanSession: () =>
        set((state) => {
          const nextValue = !state.isKanbanSessionVisible;
          return {
            isKanbanSessionVisible: nextValue,
            projectLayouts: {
              ...state.projectLayouts,
              [state.currentProjectKey]: {
                ...getCurrentSnapshot(state),
                isKanbanSessionVisible: nextValue,
              },
            },
          };
        }),

      setKanbanSessionVisible: (visible) =>
        set((state) => ({
          isKanbanSessionVisible: visible,
          projectLayouts: {
            ...state.projectLayouts,
            [state.currentProjectKey]: {
              ...getCurrentSnapshot(state),
              isKanbanSessionVisible: visible,
            },
          },
        })),

      setActiveTab: (tab) =>
        set((state) => ({
          activeTab: tab,
          projectLayouts: {
            ...state.projectLayouts,
            [state.currentProjectKey]: {
              ...getCurrentSnapshot(state),
              activeTab: tab,
            },
          },
        })),

      setProjectActiveTab: (projectKey, tab) =>
        set((state) => {
          const nextProjectSnapshot = buildProjectLayoutState(
            state.projectLayouts[projectKey]
          );
          const projectLayouts = {
            ...state.projectLayouts,
            [projectKey]: {
              ...nextProjectSnapshot,
              activeTab: tab,
            },
          };

          if (projectKey !== state.currentProjectKey) {
            return { projectLayouts };
          }

          return {
            activeTab: tab,
            projectLayouts: {
              ...projectLayouts,
              [state.currentProjectKey]: {
                ...getCurrentSnapshot(state),
                activeTab: tab,
              },
            },
          };
        }),

      resetLayout: () =>
        set((state) => {
          const nextSnapshot = {
            ...DEFAULT_LAYOUT_SNAPSHOT,
            activeTab: state.activeTab,
          };

          return {
            ...applySnapshot(nextSnapshot),
            projectLayouts: {
              ...state.projectLayouts,
              [state.currentProjectKey]: nextSnapshot,
            },
          };
        }),

      resetKanbanLayout: () =>
        set((state) => {
          const nextSnapshot = {
            ...getCurrentSnapshot(state),
            isKanbanListVisible: true,
            isKanbanMonitorVisible: true,
            isKanbanSessionVisible: true,
          };

          return {
            isKanbanListVisible: true,
            isKanbanMonitorVisible: true,
            isKanbanSessionVisible: true,
            projectLayouts: {
              ...state.projectLayouts,
              [state.currentProjectKey]: nextSnapshot,
            },
          };
        }),
    }),
    {
      name: 'vibex-ide-layout',
      version: 27,
      migrate: migratePersistedLayoutState,
      partialize: (state) => ({
        currentProjectKey: state.currentProjectKey,
        projectLayouts: {
          ...state.projectLayouts,
          [state.currentProjectKey]: getCurrentSnapshot(state),
        },
      }),
    }
  )
);
