import { create } from 'zustand';

export type AiDevServerStartStatus =
  | 'idle'
  | 'starting'
  | 'waiting_for_reply'
  | 'completed'
  | 'error';

export interface AiDevServerStartState {
  status: AiDevServerStartStatus;
  sessionId?: string;
  processId?: string;
  detectedUrl?: string;
  resultPath?: string;
  error?: string;
}

interface AiDevServerStartStore {
  byWorkspace: Record<string, AiDevServerStartState>;
  setStateForWorkspace: (
    workspaceId: string,
    nextState: AiDevServerStartState
  ) => void;
  patchStateForWorkspace: (
    workspaceId: string,
    partial: Partial<AiDevServerStartState>
  ) => void;
  clearWorkspaceState: (workspaceId: string) => void;
}

export const useAiDevServerStartStore = create<AiDevServerStartStore>()(
  (set) => ({
    byWorkspace: {},
    setStateForWorkspace: (workspaceId, nextState) =>
      set((state) => ({
        byWorkspace: {
          ...state.byWorkspace,
          [workspaceId]: nextState,
        },
      })),
    patchStateForWorkspace: (workspaceId, partial) =>
      set((state) => {
        const previousState = state.byWorkspace[workspaceId];
        return {
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceId]: {
              ...(previousState ?? {}),
              status: partial.status ?? previousState?.status ?? 'idle',
              ...partial,
            },
          },
        };
      }),
    clearWorkspaceState: (workspaceId) =>
      set((state) => {
        const rest = { ...state.byWorkspace };
        delete rest[workspaceId];
        return { byWorkspace: rest };
      }),
  })
);
