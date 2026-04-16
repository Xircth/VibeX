import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SerializedDockview } from 'dockview';
import { GLOBAL_PROJECT_SCOPE } from '@/lib/projectScope';

/**
 * Panel IDs used to register and identify panels in the dockview layout.
 */
export const PANEL_IDS = {
  KANBAN: 'kanban',
  FILE_TREE: 'file-tree',
  PREVIEW: 'preview',
  DEV_PREVIEW: 'dev-preview',
  DIFFS: 'diffs',
  TERMINAL: 'terminal',
  AI_CHAT: 'ai-chat',
  GIT: 'git',
  WELCOME: 'welcome',
  LOGS: 'logs',
  NOTES: 'notes',
  SEARCH: 'search',
} as const;

export type PanelId = (typeof PANEL_IDS)[keyof typeof PANEL_IDS];

/**
 * Group IDs for organizing panels in the dockview layout.
 */
export const GROUP_IDS = {
  LEFT: 'group-left',
  BOTTOM: 'group-bottom',
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

  /** Whether the right (AI chat) panel is visible */
  isRightPanelVisible: boolean;

  /** Active tab: workspace or kanban */
  activeTab: WorkspaceTab;

  /** Actions */
  setCurrentProject: (projectKey: string) => void;
  setSerializedLayout: (layout: SerializedDockview | null) => void;
  toggleFileTree: () => void;
  setFileTreeVisible: (visible: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  toggleRightPanel: () => void;
  setRightPanelVisible: (visible: boolean) => void;
  setActiveTab: (tab: WorkspaceTab) => void;
  setProjectActiveTab: (projectKey: string, tab: WorkspaceTab) => void;
  resetLayout: () => void;
}

const DEFAULT_RIGHT_PANEL_WIDTH = 520;
const MIN_RIGHT_PANEL_WIDTH = 400;

interface LayoutSnapshot {
  serializedLayout: SerializedDockview | null;
  isFileTreeVisible: boolean;
  rightPanelWidth: number;
  isRightPanelVisible: boolean;
  activeTab: WorkspaceTab;
}

const DEFAULT_LAYOUT_SNAPSHOT: LayoutSnapshot = {
  serializedLayout: null,
  isFileTreeVisible: true,
  rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
  isRightPanelVisible: true,
  activeTab: 'kanban',
};

function buildProjectLayoutState(
  partial?: Partial<LayoutSnapshot> | null
): LayoutSnapshot {
  return {
    ...DEFAULT_LAYOUT_SNAPSHOT,
    ...partial,
    rightPanelWidth:
      partial?.rightPanelWidth == null ||
      partial.rightPanelWidth === 420 ||
      partial.rightPanelWidth === 500
        ? DEFAULT_RIGHT_PANEL_WIDTH
        : Math.max(
            MIN_RIGHT_PANEL_WIDTH,
            Math.min(900, partial.rightPanelWidth)
          ),
  };
}

function getCurrentSnapshot(state: LayoutState): LayoutSnapshot {
  return {
    serializedLayout: state.serializedLayout,
    isFileTreeVisible: state.isFileTreeVisible,
    rightPanelWidth: state.rightPanelWidth,
    isRightPanelVisible: state.isRightPanelVisible,
    activeTab: state.activeTab,
  };
}

function applySnapshot(nextSnapshot: LayoutSnapshot): Partial<LayoutState> {
  return {
    serializedLayout: nextSnapshot.serializedLayout,
    isFileTreeVisible: nextSnapshot.isFileTreeVisible,
    rightPanelWidth: nextSnapshot.rightPanelWidth,
    isRightPanelVisible: nextSnapshot.isRightPanelVisible,
    activeTab: nextSnapshot.activeTab,
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
          const nextWidth = Math.max(
            MIN_RIGHT_PANEL_WIDTH,
            Math.min(900, width)
          );

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
    }),
    {
      name: 'vibe-ultra-ide-layout',
      version: 17,
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as Partial<LayoutState>;
        const legacySnapshot = buildProjectLayoutState({
          serializedLayout: null,
          isFileTreeVisible: state.isFileTreeVisible,
          rightPanelWidth: state.rightPanelWidth,
          isRightPanelVisible: state.isRightPanelVisible,
          activeTab: state.activeTab,
        });
        const currentProjectKey =
          state.currentProjectKey ?? GLOBAL_PROJECT_SCOPE;
        const projectLayouts = Object.entries(
          state.projectLayouts ?? {}
        ).reduce<Record<string, LayoutSnapshot>>(
          (accumulator, [projectKey, projectState]) => {
            accumulator[projectKey] = buildProjectLayoutState(projectState);
            return accumulator;
          },
          {}
        );

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
      },
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
