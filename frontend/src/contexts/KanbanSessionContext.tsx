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
import {
  createEmptyKanbanSessionLayoutState,
  isSameKanbanSession,
  placeCreatedSession,
  placeSessionFromList,
  promoteMonitorSessionToRight,
  pruneUnavailableSessions,
  replaceRightSession,
  type KanbanSessionLayoutState,
  type KanbanSessionPlacement,
} from '@/lib/kanbanSessionLayout';

interface KanbanSessionContextValue {
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
  const { activeWorktreeId } = useWorktree();
  const { data: activeWorkspaceWithSession, isLoading: isActiveWorkspaceLoading } =
    useTaskAttemptWithSession(activeWorktreeId ?? undefined);
  const isRightPanelVisible = useLayoutStore(
    (state) => state.isRightPanelVisible
  );

  const [isSessionHubVisible, setSessionHubVisible] = useState(false);
  const [layoutState, setLayoutState] = useState<KanbanSessionLayoutState>(
    createEmptyKanbanSessionLayoutState()
  );
  const [lastActiveWorkspaceId, setLastActiveWorkspaceId] = useState<
    string | null
  >(null);
  const lastSyncedWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeWorktreeId) return;
    setLastActiveWorkspaceId(activeWorktreeId);
  }, [activeWorktreeId]);

  useEffect(() => {
    setSessionHubVisible(false);
    setLayoutState(createEmptyKanbanSessionLayoutState());
    setLastActiveWorkspaceId(null);
    lastSyncedWorkspaceIdRef.current = null;
  }, [projectId]);

  // Keep right-panel session in sync when workspace changes.
  // Do not override if the current right-panel session already belongs to the
  // target workspace (e.g. switching tabs while preserving session selection).
  useEffect(() => {
    if (!activeWorktreeId) {
      return;
    }

    if (lastSyncedWorkspaceIdRef.current === activeWorktreeId) {
      return;
    }

    if (isActiveWorkspaceLoading || !activeWorkspaceWithSession) {
      return;
    }

    lastSyncedWorkspaceIdRef.current = activeWorktreeId;

    const nextSession = activeWorkspaceWithSession.session?.id
      ? {
          sessionId: activeWorkspaceWithSession.session.id,
          workspaceId: activeWorktreeId,
        }
      : null;

    setLayoutState((current) => {
      if (
        current.rightSession &&
        current.rightSession.workspaceId === activeWorktreeId
      ) {
        return current;
      }

      if (!nextSession) {
        if (current.rightSession === null) {
          return current;
        }
        return {
          ...current,
          rightSession: null,
        };
      }

      if (
        current.rightSession &&
        isSameKanbanSession(current.rightSession, nextSession) &&
        current.rightSession.workspaceId === nextSession.workspaceId
      ) {
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
  ]);

  const canUseRightPanelForSessions = isRightPanelVisible;

  const toggleSessionHub = useCallback(() => {
    setSessionHubVisible((current) => !current);
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
      canUseRightPanelForSessions,
      isSessionHubVisible,
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
