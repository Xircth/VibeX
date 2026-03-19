import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useProject } from '@/contexts/ProjectContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { useLayoutStore } from '@/stores/useLayoutStore';
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
  const { activeTaskId, activeWorktreeId } = useWorktree();
  const activeTab = useLayoutStore((state) => state.activeTab);
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

  useEffect(() => {
    if (!activeWorktreeId) return;
    setLastActiveWorkspaceId(activeWorktreeId);
  }, [activeWorktreeId]);

  useEffect(() => {
    setSessionHubVisible(false);
    setLayoutState(createEmptyKanbanSessionLayoutState());
    setLastActiveWorkspaceId(null);
  }, [projectId]);

  const canUseRightPanelForSessions =
    activeTab === 'kanban' &&
    isRightPanelVisible &&
    !activeTaskId &&
    !activeWorktreeId;

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

  const visibleRightSession = canUseRightPanelForSessions
    ? layoutState.rightSession
    : null;

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
