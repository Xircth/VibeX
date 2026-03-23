import { create } from 'zustand';
import {
  DEFAULT_KANBAN_VIEW,
  type KanbanPanelView,
} from '@/lib/kanbanPanelView';
import {
  createEmptyKanbanSessionLayoutState,
  type KanbanSessionLayoutState,
} from '@/lib/kanbanSessionLayout';

interface StoredWorktreeState {
  activeWorktreeId: string | null;
  activeTaskId: string | null;
}

interface StoredKanbanState {
  panelView: KanbanPanelView;
  layoutState: KanbanSessionLayoutState;
  lastActiveWorkspaceId: string | null;
}

interface ProjectViewStateStore {
  worktreeByProject: Record<string, StoredWorktreeState>;
  kanbanByProject: Record<string, StoredKanbanState>;
  getWorktreeState: (projectKey: string) => StoredWorktreeState;
  setWorktreeState: (
    projectKey: string,
    nextState: Partial<StoredWorktreeState>
  ) => void;
  getKanbanState: (projectKey: string) => StoredKanbanState;
  setKanbanState: (
    projectKey: string,
    nextState: Partial<StoredKanbanState>
  ) => void;
  resetKanbanState: (projectKey: string) => void;
}

function createDefaultWorktreeState(): StoredWorktreeState {
  return {
    activeWorktreeId: null,
    activeTaskId: null,
  };
}

function createDefaultKanbanState(): StoredKanbanState {
  return {
    panelView: DEFAULT_KANBAN_VIEW,
    layoutState: createEmptyKanbanSessionLayoutState(),
    lastActiveWorkspaceId: null,
  };
}

export const useProjectViewStateStore = create<ProjectViewStateStore>(
  (set, get) => ({
    worktreeByProject: {},
    kanbanByProject: {},
    getWorktreeState: (projectKey) =>
      get().worktreeByProject[projectKey] ?? createDefaultWorktreeState(),
    setWorktreeState: (projectKey, nextState) =>
      set((state) => ({
        worktreeByProject: {
          ...state.worktreeByProject,
          [projectKey]: {
            ...createDefaultWorktreeState(),
            ...state.worktreeByProject[projectKey],
            ...nextState,
          },
        },
      })),
    getKanbanState: (projectKey) =>
      get().kanbanByProject[projectKey] ?? createDefaultKanbanState(),
    setKanbanState: (projectKey, nextState) =>
      set((state) => ({
        kanbanByProject: {
          ...state.kanbanByProject,
          [projectKey]: {
            ...createDefaultKanbanState(),
            ...state.kanbanByProject[projectKey],
            ...nextState,
          },
        },
      })),
    resetKanbanState: (projectKey) =>
      set((state) => ({
        kanbanByProject: {
          ...state.kanbanByProject,
          [projectKey]: createDefaultKanbanState(),
        },
      })),
  })
);
