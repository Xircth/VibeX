import { create } from 'zustand';

interface TaskUiState {
  loading: boolean;
  isStopping: boolean;
  deletingFiles: Set<string>;
  fileToDelete: string | null;
  // Additional UI state can be added here
}

interface UiStateMap {
  [taskId: string]: TaskUiState;
}

interface TaskDetailsUiStore {
  ui: UiStateMap;
  stopToastSuppressedWorkspaceIds: Set<string>;
  getUiState: (taskId: string) => TaskUiState;
  setUiState: (taskId: string, partial: Partial<TaskUiState>) => void;
  clearUiState: (taskId: string) => void;
  markStopToastSuppressed: (workspaceId: string) => void;
  clearStopToastSuppression: (workspaceId: string) => void;
  consumeStopToastSuppression: (workspaceId: string) => boolean;
}

const defaultUiState: TaskUiState = {
  loading: false,
  isStopping: false,
  deletingFiles: new Set(),
  fileToDelete: null,
};

const useTaskDetailsUiStore = create<TaskDetailsUiStore>((set, get) => ({
  ui: {},
  stopToastSuppressedWorkspaceIds: new Set(),

  getUiState: (taskId: string) => {
    return get().ui[taskId] ?? defaultUiState;
  },

  setUiState: (taskId: string, partial: Partial<TaskUiState>) => {
    set((state) => ({
      ui: {
        ...state.ui,
        [taskId]: {
          ...defaultUiState,
          ...state.ui[taskId],
          ...partial,
          // Handle Set immutability for deletingFiles
          deletingFiles: partial.deletingFiles
            ? new Set(partial.deletingFiles)
            : (state.ui[taskId]?.deletingFiles ?? new Set()),
        },
      },
    }));
  },

  clearUiState: (taskId: string) => {
    set((state) => {
      const newUi = { ...state.ui };
      delete newUi[taskId];
      return { ui: newUi };
    });
  },

  markStopToastSuppressed: (workspaceId: string) => {
    set((state) => {
      const next = new Set(state.stopToastSuppressedWorkspaceIds);
      next.add(workspaceId);
      return { stopToastSuppressedWorkspaceIds: next };
    });
  },

  clearStopToastSuppression: (workspaceId: string) => {
    set((state) => {
      const next = new Set(state.stopToastSuppressedWorkspaceIds);
      next.delete(workspaceId);
      return { stopToastSuppressedWorkspaceIds: next };
    });
  },

  consumeStopToastSuppression: (workspaceId: string) => {
    const current = get().stopToastSuppressedWorkspaceIds;
    if (!current.has(workspaceId)) {
      return false;
    }

    set((state) => {
      const next = new Set(state.stopToastSuppressedWorkspaceIds);
      next.delete(workspaceId);
      return { stopToastSuppressedWorkspaceIds: next };
    });
    return true;
  },
}));

export const useTaskStopping = (taskId: string) => {
  const { getUiState, setUiState } = useTaskDetailsUiStore();
  const { isStopping } = getUiState(taskId);

  return {
    isStopping,
    setIsStopping: (value: boolean) =>
      setUiState(taskId, { isStopping: value }),
  };
};

export const useStopToastSuppression = () => {
  const markStopToastSuppressed = useTaskDetailsUiStore(
    (state) => state.markStopToastSuppressed
  );
  const clearStopToastSuppression = useTaskDetailsUiStore(
    (state) => state.clearStopToastSuppression
  );
  const consumeStopToastSuppression = useTaskDetailsUiStore(
    (state) => state.consumeStopToastSuppression
  );

  return {
    markStopToastSuppressed,
    clearStopToastSuppression,
    consumeStopToastSuppression,
  };
};
