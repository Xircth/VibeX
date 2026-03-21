import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SerializedDockview } from 'dockview';

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
  setSerializedLayout: (layout: SerializedDockview | null) => void;
  toggleFileTree: () => void;
  setFileTreeVisible: (visible: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  toggleRightPanel: () => void;
  setRightPanelVisible: (visible: boolean) => void;
  setActiveTab: (tab: WorkspaceTab) => void;
  resetLayout: () => void;
}

const DEFAULT_RIGHT_PANEL_WIDTH = 520;
const MIN_RIGHT_PANEL_WIDTH = 400;

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      serializedLayout: null,
      isFileTreeVisible: true,
      rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
      isRightPanelVisible: true,
      activeTab: 'kanban' as WorkspaceTab,

      setSerializedLayout: (layout) => set({ serializedLayout: layout }),

      toggleFileTree: () =>
        set((s) => ({ isFileTreeVisible: !s.isFileTreeVisible })),

      setFileTreeVisible: (visible) => set({ isFileTreeVisible: visible }),

      setRightPanelWidth: (width) =>
        set({
          rightPanelWidth: Math.max(
            MIN_RIGHT_PANEL_WIDTH,
            Math.min(900, width)
          ),
        }),

      toggleRightPanel: () =>
        set((s) => ({ isRightPanelVisible: !s.isRightPanelVisible })),

      setRightPanelVisible: (visible) => set({ isRightPanelVisible: visible }),

      setActiveTab: (tab) => set({ activeTab: tab }),

      resetLayout: () =>
        set((s) => ({
          serializedLayout: null,
          isFileTreeVisible: true,
          rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
          isRightPanelVisible: true,
          activeTab: s.activeTab,
        })),
    }),
    {
      name: 'vibe-ultra-ide-layout',
      version: 16,
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as Partial<LayoutState>;
        const nextRightPanelWidth =
          state.rightPanelWidth == null ||
          state.rightPanelWidth === 420 ||
          state.rightPanelWidth === 500
            ? DEFAULT_RIGHT_PANEL_WIDTH
            : Math.max(
                MIN_RIGHT_PANEL_WIDTH,
                Math.min(900, state.rightPanelWidth)
              );

        return {
          serializedLayout: null,
          isFileTreeVisible: state.isFileTreeVisible ?? true,
          rightPanelWidth: nextRightPanelWidth,
          isRightPanelVisible: state.isRightPanelVisible ?? true,
          activeTab: state.activeTab ?? ('kanban' as WorkspaceTab),
        };
      },
      partialize: (state) => ({
        serializedLayout: state.serializedLayout,
        isFileTreeVisible: state.isFileTreeVisible,
        rightPanelWidth: state.rightPanelWidth,
        isRightPanelVisible: state.isRightPanelVisible,
        activeTab: state.activeTab,
      }),
    }
  )
);
