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
} as const;

export type PanelId = (typeof PANEL_IDS)[keyof typeof PANEL_IDS];

/**
 * Group IDs for organizing panels in the dockview layout.
 */
export const GROUP_IDS = {
  LEFT: 'group-left',
  CENTER_1: 'group-center-1',
  CENTER_2: 'group-center-2',
  BOTTOM: 'group-bottom',
} as const;

export type GroupId = (typeof GROUP_IDS)[keyof typeof GROUP_IDS];

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

const DEFAULT_RIGHT_PANEL_WIDTH = 420;
const MIN_RIGHT_PANEL_WIDTH = 360;

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
        set({ rightPanelWidth: Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(800, width)) }),

      toggleRightPanel: () =>
        set((s) => ({ isRightPanelVisible: !s.isRightPanelVisible })),

      setRightPanelVisible: (visible) => set({ isRightPanelVisible: visible }),

      setActiveTab: (tab) => set({ activeTab: tab }),

      resetLayout: () =>
        set({
          serializedLayout: null,
          isFileTreeVisible: true,
          rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
          isRightPanelVisible: true,
          activeTab: 'kanban' as WorkspaceTab,
        }),
    }),
    {
      name: 'vibe-kanban-ide-layout',
      version: 10,
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as Partial<LayoutState>;
        const nextRightPanelWidth =
          state.rightPanelWidth == null || state.rightPanelWidth === 500
            ? DEFAULT_RIGHT_PANEL_WIDTH
            : Math.max(
                MIN_RIGHT_PANEL_WIDTH,
                Math.min(800, state.rightPanelWidth)
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
