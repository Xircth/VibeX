import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { normalizeProjectRoute } from '@/lib/paths';

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
  /** Number of in-flight (running) sessions — drives the status-bar count (P3-5). */
  runningCount: number;
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
  pruneProjectState: (validProjectIds: string[]) => void;
  resetProjectWindowState: () => void;
  requestProjectFocus: (
    projectId: string,
    focusRequest: ProjectFocusRequest
  ) => void;
  consumeProjectFocus: (projectId: string) => ProjectFocusRequest | undefined;
}

type PersistedWindowProjectsState = {
  railVisible?: boolean;
  openProjectIds?: string[];
  lastRouteByProject?: Record<string, string>;
  projectSnapshots?: Record<string, ProjectActivitySnapshot>;
  projectAlerts?: Record<string, ProjectActivityAlert | undefined>;
};

function arraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function isSameSnapshot(
  left: ProjectActivitySnapshot | undefined,
  right: ProjectActivitySnapshot
) {
  if (!left) {
    return false;
  }

  if (
    left.isLoading !== right.isLoading ||
    left.hasRunning !== right.hasRunning ||
    left.runningCount !== right.runningCount ||
    left.hasError !== right.hasError ||
    left.hasSessions !== right.hasSessions ||
    left.recentSessions.length !== right.recentSessions.length
  ) {
    return false;
  }

  return left.recentSessions.every((session, index) => {
    const nextSession = right.recentSessions[index];
    return (
      session.sessionId === nextSession.sessionId &&
      session.workspaceId === nextSession.workspaceId &&
      session.taskId === nextSession.taskId &&
      session.title === nextSession.title &&
      session.subtitle === nextSession.subtitle &&
      session.statusLabel === nextSession.statusLabel &&
      session.visualState === nextSession.visualState &&
      session.updatedAt === nextSession.updatedAt
    );
  });
}

function isSameAlert(
  left: ProjectActivityAlert | undefined,
  right: ProjectActivityAlert
) {
  if (!left) {
    return false;
  }

  return (
    left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.taskId === right.taskId &&
    left.kind === right.kind &&
    left.unread === right.unread &&
    left.createdAt === right.createdAt &&
    left.title === right.title &&
    left.description === right.description
  );
}

function filterRecordByProjectIds<T>(
  record: Record<string, T>,
  validProjectIds: Set<string>
) {
  return Object.fromEntries(
    Object.entries(record).filter(([projectId]) =>
      validProjectIds.has(projectId)
    )
  ) as Record<string, T>;
}

export const useWindowProjectsStore = create<WindowProjectsState>()(
  persist(
    (set, get) => ({
      railVisible: false,
      openProjectIds: [],
      lastRouteByProject: {},
      projectSnapshots: {},
      projectAlerts: {},
      focusRequests: {},
      setRailVisible: (visible) =>
        set((state) =>
          state.railVisible === visible ? state : { railVisible: visible }
        ),
      toggleRailVisible: () =>
        set((state) => ({ railVisible: !state.railVisible })),
      ensureProjectOpen: (projectId) =>
        set((state) => {
          const nextOpenProjectIds = [
            projectId,
            ...state.openProjectIds.filter((id) => id !== projectId),
          ].slice(0, 8);

          return arraysEqual(state.openProjectIds, nextOpenProjectIds)
            ? state
            : { openProjectIds: nextOpenProjectIds };
        }),
      rememberProjectRoute: (projectId, route) =>
        set((state) =>
          state.lastRouteByProject[projectId] === normalizeProjectRoute(route)
            ? state
            : {
                lastRouteByProject: {
                  ...state.lastRouteByProject,
                  [projectId]: normalizeProjectRoute(route),
                },
              }
        ),
      setProjectSnapshot: (projectId, snapshot) =>
        set((state) => {
          const nextOpenProjectIds = state.openProjectIds.includes(projectId)
            ? state.openProjectIds
            : [projectId, ...state.openProjectIds].slice(0, 8);
          const sameOrder = arraysEqual(
            state.openProjectIds,
            nextOpenProjectIds
          );
          const sameSnapshot = isSameSnapshot(
            state.projectSnapshots[projectId],
            snapshot
          );

          if (sameOrder && sameSnapshot) {
            return state;
          }

          return {
            openProjectIds: nextOpenProjectIds,
            projectSnapshots: sameSnapshot
              ? state.projectSnapshots
              : {
                  ...state.projectSnapshots,
                  [projectId]: snapshot,
                },
          };
        }),
      setProjectAlert: (alert) =>
        set((state) => {
          const nextOpenProjectIds = state.openProjectIds.includes(
            alert.projectId
          )
            ? state.openProjectIds
            : [alert.projectId, ...state.openProjectIds].slice(0, 8);
          const sameOrder = arraysEqual(
            state.openProjectIds,
            nextOpenProjectIds
          );
          const sameAlert = isSameAlert(
            state.projectAlerts[alert.projectId],
            alert
          );

          if (sameOrder && sameAlert) {
            return state;
          }

          return {
            openProjectIds: nextOpenProjectIds,
            projectAlerts: sameAlert
              ? state.projectAlerts
              : {
                  ...state.projectAlerts,
                  [alert.projectId]: alert,
                },
          };
        }),
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
      pruneProjectState: (validProjectIds) =>
        set((state) => {
          const validProjectIdSet = new Set(validProjectIds);
          const nextOpenProjectIds = state.openProjectIds.filter((projectId) =>
            validProjectIdSet.has(projectId)
          );
          const nextLastRouteByProject = filterRecordByProjectIds(
            state.lastRouteByProject,
            validProjectIdSet
          );
          const nextProjectSnapshots = filterRecordByProjectIds(
            state.projectSnapshots,
            validProjectIdSet
          );
          const nextProjectAlerts = filterRecordByProjectIds(
            state.projectAlerts,
            validProjectIdSet
          );
          const nextFocusRequests = filterRecordByProjectIds(
            state.focusRequests,
            validProjectIdSet
          );

          if (
            arraysEqual(state.openProjectIds, nextOpenProjectIds) &&
            Object.keys(state.lastRouteByProject).length ===
              Object.keys(nextLastRouteByProject).length &&
            Object.keys(state.projectSnapshots).length ===
              Object.keys(nextProjectSnapshots).length &&
            Object.keys(state.projectAlerts).length ===
              Object.keys(nextProjectAlerts).length &&
            Object.keys(state.focusRequests).length ===
              Object.keys(nextFocusRequests).length
          ) {
            return state;
          }

          return {
            openProjectIds: nextOpenProjectIds,
            lastRouteByProject: nextLastRouteByProject,
            projectSnapshots: nextProjectSnapshots,
            projectAlerts: nextProjectAlerts,
            focusRequests: nextFocusRequests,
          };
        }),
      resetProjectWindowState: () =>
        set({
          railVisible: false,
          openProjectIds: [],
          lastRouteByProject: {},
          projectSnapshots: {},
          projectAlerts: {},
          focusRequests: {},
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
      name: 'vibex-window-projects',
      version: 4,
      migrate: (persistedState: unknown) => {
        const state = (persistedState ?? {}) as PersistedWindowProjectsState;
        const normalizedLastRouteByProject = Object.fromEntries(
          Object.entries(state.lastRouteByProject ?? {}).map(
            ([projectId, route]) => [projectId, normalizeProjectRoute(route)]
          )
        );

        return {
          railVisible: false,
          openProjectIds: state.openProjectIds ?? [],
          lastRouteByProject: normalizedLastRouteByProject,
          projectSnapshots: state.projectSnapshots ?? {},
          projectAlerts: state.projectAlerts ?? {},
          focusRequests: {},
        };
      },
      partialize: (state) => ({
        openProjectIds: state.openProjectIds,
        lastRouteByProject: state.lastRouteByProject,
        // runningCount reflects live in-flight sessions, which never survive an
        // app restart — persist it as 0 so the status-bar count badge doesn't show
        // a phantom count on the next launch before trackers reload (P3-5).
        projectSnapshots: Object.fromEntries(
          Object.entries(state.projectSnapshots).map(([id, snapshot]) => [
            id,
            { ...snapshot, runningCount: 0 },
          ])
        ),
        projectAlerts: state.projectAlerts,
      }),
    }
  )
);
