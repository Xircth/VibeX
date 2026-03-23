import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { getProjectScopeKey } from '@/lib/projectScope';
import {
  createEmptyKanbanSessionLayoutState,
  placeCreatedSession,
  placeSessionFromList,
  promoteMonitorSessionToRight,
  pruneUnavailableSessions,
  replaceRightSession,
  type KanbanSessionLayoutState,
  type KanbanSessionPlacement,
} from '@/lib/kanbanSessionLayout';
import {
  DEFAULT_KANBAN_VIEW,
  type KanbanPanelView,
} from '@/lib/kanbanPanelView';
import { useProjectViewStateStore } from '@/stores/useProjectViewStateStore';

interface KanbanSessionContextValue {
  panelView: KanbanPanelView;
  setPanelView: (view: KanbanPanelView) => void;
  goToBoard: () => void;
  goToSessionHub: () => void;
  goToUsageDashboard: () => void;
  isSessionHubVisible: boolean;
  setSessionHubVisible: (visible: boolean) => void;
  toggleSessionHub: () => void;
  rightSession: KanbanSessionPlacement | null;
  visibleRightSession: KanbanSessionPlacement | null;
  monitorSessions: KanbanSessionPlacement[];
  lastActiveWorkspaceId: string | null;
  canUseRightPanelForSessions: boolean;
  openSessionFromList: (session: KanbanSessionPlacement) => void;
  placeCreatedSession: (session: KanbanSessionPlacement) => void;
  replaceRightSession: (session: KanbanSessionPlacement) => void;
  promoteMonitorSession: (sessionId: string) => void;
  pruneSessions: (availableSessionIds: Set<string>) => void;
}

const KanbanSessionContext = createContext<KanbanSessionContextValue | null>(
  null
);

export function KanbanSessionProvider({ children }: { children: ReactNode }) {
  const { projectId } = useProject();
  const projectKey = getProjectScopeKey(projectId);
  const { activeWorktreeId } = useWorktree();
  const { data: activeWorkspaceWithSession, isLoading: isActiveWorkspaceLoading } =
    useTaskAttemptWithSession(activeWorktreeId ?? undefined);
  const isRightPanelVisible = useLayoutStore(
    (state) => state.isRightPanelVisible
  );

  const [panelView, setPanelView] = useState<KanbanPanelView>(DEFAULT_KANBAN_VIEW);
  const [layoutState, setLayoutState] = useState<KanbanSessionLayoutState>(
    createEmptyKanbanSessionLayoutState()
  );
  const [lastActiveWorkspaceId, setLastActiveWorkspaceId] = useState<
    string | null
  >(null);
  const lastSyncedWorkspaceIdRef = useRef<string | null>(null);

  // Derived state for backward compatibility
  const isSessionHubVisible = panelView === 'sessionHub';

  useEffect(() => {
    const stored = useProjectViewStateStore.getState().getKanbanState(projectKey);
    setPanelView(stored.panelView);
    setLayoutState(stored.layoutState);
    setLastActiveWorkspaceId(stored.lastActiveWorkspaceId);
    lastSyncedWorkspaceIdRef.current = null;
  }, [projectKey]);

  useEffect(() => {
    useProjectViewStateStore.getState().setKanbanState(projectKey, {
      panelView,
      layoutState,
      lastActiveWorkspaceId,
    });
  }, [projectKey, panelView, layoutState, lastActiveWorkspaceId]);

  useEffect(() => {
    if (!activeWorktreeId) return;
    setLastActiveWorkspaceId(activeWorktreeId);
  }, [activeWorktreeId]);

  useEffect(() => {
    if (!projectId) {
      setPanelView(DEFAULT_KANBAN_VIEW);
      setLayoutState(createEmptyKanbanSessionLayoutState());
      setLastActiveWorkspaceId(null);
      lastSyncedWorkspaceIdRef.current = null;
      useProjectViewStateStore
        .getState()
        .resetKanbanState(getProjectScopeKey(projectId));
    }
  }, [projectId]);

  // Seed the right panel from the active workspace when nothing is selected yet.
  // Once the user has chosen a session for the right panel, keep that selection
  // stable across kanban/workspace switches until they explicitly change it.
  useEffect(() => {
    if (!activeWorktreeId) {
      return;
    }

    // When right panel is empty, always try to re-seed from the current workspace
    // (even if we previously synced this workspace).
    if (lastSyncedWorkspaceIdRef.current === activeWorktreeId && layoutState.rightSession) {
      return;
    }

    if (isActiveWorkspaceLoading || !activeWorkspaceWithSession) {
      return;
    }

    const nextSession = activeWorkspaceWithSession.session?.id
      ? {
          sessionId: activeWorkspaceWithSession.session.id,
          workspaceId: activeWorktreeId,
        }
      : null;

    if (nextSession) {
      lastSyncedWorkspaceIdRef.current = activeWorktreeId;
    }

    setLayoutState((current) => {
      if (current.rightSession) {
        return current;
      }

      if (!nextSession) {
        return current;
      }

      return replaceRightSession(current, nextSession, {
        canUseRightPanel: true,
      });
    });
  }, [
    activeWorkspaceWithSession,
    activeWorktreeId,
    isActiveWorkspaceLoading,
    layoutState.rightSession,
  ]);

  const canUseRightPanelForSessions = isRightPanelVisible;

  const goToBoard = useCallback(() => {
    setPanelView('board');
  }, []);

  const goToSessionHub = useCallback(() => {
    setPanelView('sessionHub');
  }, []);

  const goToUsageDashboard = useCallback(() => {
    setPanelView('usageDashboard');
  }, []);

  const toggleSessionHub = useCallback(() => {
    setPanelView((current) => {
      if (current === 'sessionHub') {
        return 'board';
      }
      return 'sessionHub';
    });
  }, []);

  const setSessionHubVisible = useCallback((visible: boolean) => {
    setPanelView(visible ? 'sessionHub' : 'board');
  }, []);

  const openSessionFromList = useCallback(
    (session: KanbanSessionPlacement) => {
      setLayoutState((current) =>
        placeSessionFromList(current, session, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions]
  );

  const placeCreatedSessionInLayout = useCallback(
    (session: KanbanSessionPlacement) => {
      setLayoutState((current) =>
        placeCreatedSession(current, session, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions]
  );

  const replaceRightSessionInLayout = useCallback(
    (session: KanbanSessionPlacement) => {
      setLayoutState((current) =>
        replaceRightSession(current, session, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions]
  );

  const promoteMonitorSession = useCallback(
    (sessionId: string) => {
      setLayoutState((current) =>
        promoteMonitorSessionToRight(current, sessionId, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions]
  );

  const pruneSessions = useCallback((availableSessionIds: Set<string>) => {
    setLayoutState((current) =>
      pruneUnavailableSessions(current, availableSessionIds)
    );
  }, []);

  const visibleRightSession = layoutState.rightSession;

  const value = useMemo<KanbanSessionContextValue>(
    () => ({
      panelView,
      setPanelView,
      goToBoard,
      goToSessionHub,
      goToUsageDashboard,
      isSessionHubVisible,
      setSessionHubVisible,
      toggleSessionHub,
      rightSession: layoutState.rightSession,
      visibleRightSession,
      monitorSessions: layoutState.monitorSessions,
      lastActiveWorkspaceId,
      canUseRightPanelForSessions,
      openSessionFromList,
      placeCreatedSession: placeCreatedSessionInLayout,
      replaceRightSession: replaceRightSessionInLayout,
      promoteMonitorSession,
      pruneSessions,
    }),
    [
      panelView,
      goToBoard,
      goToSessionHub,
      goToUsageDashboard,
      isSessionHubVisible,
      canUseRightPanelForSessions,
      lastActiveWorkspaceId,
      layoutState.monitorSessions,
      layoutState.rightSession,
      openSessionFromList,
      placeCreatedSessionInLayout,
      replaceRightSessionInLayout,
      promoteMonitorSession,
      pruneSessions,
      toggleSessionHub,
      visibleRightSession,
    ]
  );

  return (
    <KanbanSessionContext.Provider value={value}>
      {children}
    </KanbanSessionContext.Provider>
  );
}

export function useKanbanSessionContext() {
  const context = useContext(KanbanSessionContext);
  if (!context) {
    throw new Error(
      'useKanbanSessionContext must be used within KanbanSessionProvider'
    );
  }
  return context;
}

export function useOptionalKanbanSessionContext() {
  return useContext(KanbanSessionContext);
}
