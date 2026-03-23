import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ProjectActivityVisualState =
  | 'idle'
  | 'loading'
  | 'success'
  | 'success-unread'
  | 'error'
  | 'error-unread';

export interface ProjectRecentSessionSnapshot {
  sessionId: string;
  workspaceId: string;
  taskId: string | null;
  title: string;
  subtitle: string;
  statusLabel: string;
  visualState: 'loading' | 'success' | 'error' | 'idle';
  updatedAt: string;
}

export interface ProjectActivitySnapshot {
  isLoading: boolean;
  hasRunning: boolean;
  hasError: boolean;
  hasSessions: boolean;
  recentSessions: ProjectRecentSessionSnapshot[];
}

export interface ProjectActivityAlert {
  projectId: string;
  workspaceId: string;
  sessionId: string;
  taskId: string | null;
  kind: 'success' | 'error';
  unread: boolean;
  createdAt: string;
  title: string;
  description: string;
}

interface ProjectFocusRequest {
  workspaceId: string;
  sessionId: string;
  requestedAt: number;
}

interface WindowProjectsState {
  railVisible: boolean;
  openProjectIds: string[];
  lastRouteByProject: Record<string, string>;
  projectSnapshots: Record<string, ProjectActivitySnapshot>;
  projectAlerts: Record<string, ProjectActivityAlert | undefined>;
  focusRequests: Record<string, ProjectFocusRequest | undefined>;
  setRailVisible: (visible: boolean) => void;
  toggleRailVisible: () => void;
  ensureProjectOpen: (projectId: string) => void;
  rememberProjectRoute: (projectId: string, route: string) => void;
  setProjectSnapshot: (
    projectId: string,
    snapshot: ProjectActivitySnapshot
  ) => void;
  setProjectAlert: (alert: ProjectActivityAlert) => void;
  markProjectAlertRead: (projectId: string) => void;
  requestProjectFocus: (
    projectId: string,
    focusRequest: ProjectFocusRequest
  ) => void;
  consumeProjectFocus: (projectId: string) => ProjectFocusRequest | undefined;
}

export const useWindowProjectsStore = create<WindowProjectsState>()(
  persist(
    (set, get) => ({
      railVisible: true,
      openProjectIds: [],
      lastRouteByProject: {},
      projectSnapshots: {},
      projectAlerts: {},
      focusRequests: {},
      setRailVisible: (visible) => set({ railVisible: visible }),
      toggleRailVisible: () =>
        set((state) => ({ railVisible: !state.railVisible })),
      ensureProjectOpen: (projectId) =>
        set((state) => ({
          openProjectIds: state.openProjectIds.includes(projectId)
            ? state.openProjectIds
            : [projectId, ...state.openProjectIds].slice(0, 8),
        })),
      rememberProjectRoute: (projectId, route) =>
        set((state) => ({
          lastRouteByProject: {
            ...state.lastRouteByProject,
            [projectId]: route,
          },
        })),
      setProjectSnapshot: (projectId, snapshot) =>
        set((state) => ({
          openProjectIds: state.openProjectIds.includes(projectId)
            ? state.openProjectIds
            : [projectId, ...state.openProjectIds].slice(0, 8),
          projectSnapshots: {
            ...state.projectSnapshots,
            [projectId]: snapshot,
          },
        })),
      setProjectAlert: (alert) =>
        set((state) => ({
          projectAlerts: {
            ...state.projectAlerts,
            [alert.projectId]: alert,
          },
          openProjectIds: state.openProjectIds.includes(alert.projectId)
            ? state.openProjectIds
            : [alert.projectId, ...state.openProjectIds].slice(0, 8),
        })),
      markProjectAlertRead: (projectId) =>
        set((state) => {
          const existingAlert = state.projectAlerts[projectId];
          if (!existingAlert || !existingAlert.unread) {
            return state;
          }

          return {
            projectAlerts: {
              ...state.projectAlerts,
              [projectId]: {
                ...existingAlert,
                unread: false,
              },
            },
          };
        }),
      requestProjectFocus: (projectId, focusRequest) =>
        set((state) => ({
          focusRequests: {
            ...state.focusRequests,
            [projectId]: focusRequest,
          },
        })),
      consumeProjectFocus: (projectId) => {
        const focusRequest = get().focusRequests[projectId];
        if (!focusRequest) {
          return undefined;
        }

        set((state) => {
          const nextFocusRequests = { ...state.focusRequests };
          delete nextFocusRequests[projectId];
          return {
            focusRequests: nextFocusRequests,
          };
        });

        return focusRequest;
      },
    }),
    {
      name: 'vibe-ultra-window-projects',
      version: 2,
      partialize: (state) => ({
        railVisible: state.railVisible,
        openProjectIds: state.openProjectIds,
        lastRouteByProject: state.lastRouteByProject,
        projectSnapshots: state.projectSnapshots,
        projectAlerts: state.projectAlerts,
      }),
    }
  )
);
