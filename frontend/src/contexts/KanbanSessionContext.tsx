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
  activateSessionInExecutionArea,
  createEmptyKanbanSessionLayoutState,
  placeCreatedSession,
  placeForkedChild,
  placeSessionFromList,
  promoteMonitorSessionToRight,
  pruneUnavailableSessions,
  removeMonitorSession,
  replaceRightSession,
  type KanbanSessionLayoutState,
  type KanbanSessionPlacement,
} from '@/lib/kanbanSessionLayout';
import {
  DEFAULT_KANBAN_VIEW,
  type KanbanPanelView,
} from '@/lib/kanbanPanelView';
import {
  DEFAULT_KANBAN_VIEW_ID,
  legacyKanbanPanelView,
  migrateKanbanViewId,
  viewIdForBoardStyleChange,
} from '@/lib/kanbanViews';
import {
  getKanbanBoardStyle,
  useKanbanBoardStyle,
} from '@/lib/kanbanBoardStyle';
import { shouldRevealKanbanMonitorOnPlacement } from '@/lib/kanbanZoneVisibility';
import { useProjectViewStateStore } from '@/stores/useProjectViewStateStore';

interface KanbanSessionContextValue {
  panelView: KanbanPanelView;
  activeViewId: string;
  setActiveViewId: (viewId: string) => void;
  setPanelView: (view: KanbanPanelView) => void;
  goToBoard: () => void;
  goToSessionHub: () => void;
  goToUsageDashboard: () => void;
  isSessionHubVisible: boolean;
  setSessionHubVisible: (visible: boolean) => void;
  toggleSessionHub: () => void;
  rightSession: KanbanSessionPlacement | null;
  visibleRightSession: KanbanSessionPlacement | null;
  isRightSessionPending: boolean;
  monitorSessions: KanbanSessionPlacement[];
  lastActiveWorkspaceId: string | null;
  canUseRightPanelForSessions: boolean;
  isLayoutHydrated: boolean;
  openSessionFromList: (session: KanbanSessionPlacement) => void;
  placeCreatedSession: (session: KanbanSessionPlacement) => void;
  placeForkedChild: (
    session: KanbanSessionPlacement,
    parentSessionId: string | null
  ) => void;
  replaceRightSession: (session: KanbanSessionPlacement) => void;
  activateExecutionSession: (session: KanbanSessionPlacement) => void;
  promoteMonitorSession: (sessionId: string) => void;
  cancelMonitorSession: (sessionId: string) => void;
  pruneSessions: (
    availableSessionIds: Set<string>,
    knownWorkspaceIds?: Set<string>
  ) => void;
}

const KanbanSessionContext = createContext<KanbanSessionContextValue | null>(
  null
);

export function KanbanSessionProvider({ children }: { children: ReactNode }) {
  const { projectId } = useProject();
  const projectKey = getProjectScopeKey(projectId);
  const { activeWorktreeId } = useWorktree();
  const {
    data: activeWorkspaceWithSession,
    isLoading: isActiveWorkspaceLoading,
  } = useTaskAttemptWithSession(activeWorktreeId ?? undefined);
  const isKanbanSessionVisible = useLayoutStore(
    (state) => state.isKanbanSessionVisible
  );
  const boardStyle = useKanbanBoardStyle();

  const [panelView, setPanelViewState] =
    useState<KanbanPanelView>(DEFAULT_KANBAN_VIEW);
  const [activeViewId, setActiveViewIdState] = useState<string>(
    DEFAULT_KANBAN_VIEW_ID
  );
  const [layoutState, setLayoutState] = useState<KanbanSessionLayoutState>(
    createEmptyKanbanSessionLayoutState()
  );
  const [lastActiveWorkspaceId, setLastActiveWorkspaceId] = useState<
    string | null
  >(null);
  const [hydratedProjectKey, setHydratedProjectKey] = useState<string | null>(
    null
  );
  const lastSyncedWorkspaceIdRef = useRef<string | null>(null);

  // Derived state for backward compatibility
  const isSessionHubVisible = panelView === 'sessionHub';

  useEffect(() => {
    const stored = useProjectViewStateStore
      .getState()
      .getKanbanState(projectKey);
    const style = getKanbanBoardStyle();
    const migrated =
      stored.activeViewId ?? migrateKanbanViewId(stored.panelView, style);
    const viewId = viewIdForBoardStyleChange(style, migrated);
    setPanelViewState(legacyKanbanPanelView(viewId));
    setActiveViewIdState(viewId);
    setLayoutState(stored.layoutState);
    setLastActiveWorkspaceId(stored.lastActiveWorkspaceId);
    lastSyncedWorkspaceIdRef.current = null;
    setHydratedProjectKey(projectKey);
  }, [projectKey]);

  useEffect(() => {
    if (hydratedProjectKey !== projectKey) return;
    useProjectViewStateStore.getState().setKanbanState(projectKey, {
      panelView,
      activeViewId,
      layoutState,
      lastActiveWorkspaceId,
    });
  }, [
    hydratedProjectKey,
    projectKey,
    panelView,
    activeViewId,
    layoutState,
    lastActiveWorkspaceId,
  ]);

  useEffect(() => {
    if (!activeWorktreeId) return;
    setLastActiveWorkspaceId(activeWorktreeId);
  }, [activeWorktreeId]);

  useEffect(() => {
    if (hydratedProjectKey !== projectKey) return;
    setActiveViewIdState((current) => {
      const next = viewIdForBoardStyleChange(boardStyle, current);
      if (next !== current) {
        setPanelViewState(legacyKanbanPanelView(next));
      }
      return next;
    });
  }, [boardStyle, hydratedProjectKey, projectKey]);

  const setActiveViewId = useCallback((viewId: string) => {
    setActiveViewIdState(viewId);
    setPanelViewState(legacyKanbanPanelView(viewId));
  }, []);

  const setPanelView = useCallback((view: KanbanPanelView) => {
    setPanelViewState(view);
    setActiveViewIdState(migrateKanbanViewId(view, getKanbanBoardStyle()));
  }, []);

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
  }, [projectId, setPanelView]);

  // Seed the right panel from the active workspace when nothing is selected yet.
  // Once the user has chosen a session for the right panel, keep that selection
  // stable across kanban/workspace switches until they explicitly change it.
  useEffect(() => {
    if (!activeWorktreeId) {
      return;
    }

    // When right panel is empty, always try to re-seed from the current workspace
    // (even if we previously synced this workspace).
    if (
      lastSyncedWorkspaceIdRef.current === activeWorktreeId &&
      layoutState.rightSession
    ) {
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

  const canUseRightPanelForSessions = isKanbanSessionVisible;
  const isLayoutHydrated = hydratedProjectKey === projectKey;

  const goToBoard = useCallback(() => {
    setActiveViewId('builtin:columns');
  }, [setActiveViewId]);

  const goToSessionHub = useCallback(() => {
    setActiveViewId('builtin:sessions');
  }, [setActiveViewId]);

  const goToUsageDashboard = useCallback(() => {
    setActiveViewId('builtin:usage');
  }, [setActiveViewId]);

  const toggleSessionHub = useCallback(() => {
    setActiveViewIdState((current) => {
      const next =
        current === 'builtin:sessions' ? 'builtin:columns' : 'builtin:sessions';
      setPanelViewState(legacyKanbanPanelView(next));
      return next;
    });
  }, []);

  const setSessionHubVisible = useCallback(
    (visible: boolean) => {
      setActiveViewId(visible ? 'builtin:sessions' : 'builtin:columns');
    },
    [setActiveViewId]
  );

  const commitLayoutState = useCallback(
    (
      updater: (current: KanbanSessionLayoutState) => KanbanSessionLayoutState
    ) => {
      setLayoutState((current) => {
        const next = updater(current);
        if (
          shouldRevealKanbanMonitorOnPlacement(
            current.monitorSessions.length,
            next.monitorSessions.length
          )
        ) {
          useLayoutStore.getState().setKanbanMonitorVisible(true);
        }
        return next;
      });
    },
    []
  );

  const openSessionFromList = useCallback(
    (session: KanbanSessionPlacement) => {
      commitLayoutState((current) =>
        placeSessionFromList(current, session, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions, commitLayoutState]
  );

  const placeCreatedSessionInLayout = useCallback(
    (session: KanbanSessionPlacement) => {
      commitLayoutState((current) =>
        placeCreatedSession(current, session, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions, commitLayoutState]
  );

  const placeForkedChildInLayout = useCallback(
    (session: KanbanSessionPlacement, parentSessionId: string | null) => {
      commitLayoutState((current) =>
        placeForkedChild(current, session, parentSessionId, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions, commitLayoutState]
  );

  const replaceRightSessionInLayout = useCallback(
    (session: KanbanSessionPlacement) => {
      commitLayoutState((current) =>
        replaceRightSession(current, session, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions, commitLayoutState]
  );

  const activateExecutionSession = useCallback(
    (session: KanbanSessionPlacement) => {
      commitLayoutState((current) =>
        activateSessionInExecutionArea(current, session, {
          canUseRightPanel: true,
        })
      );
    },
    [commitLayoutState]
  );

  const promoteMonitorSession = useCallback(
    (sessionId: string) => {
      commitLayoutState((current) =>
        promoteMonitorSessionToRight(current, sessionId, {
          canUseRightPanel: canUseRightPanelForSessions,
        })
      );
    },
    [canUseRightPanelForSessions, commitLayoutState]
  );

  const cancelMonitorSession = useCallback(
    (sessionId: string) => {
      commitLayoutState((current) => removeMonitorSession(current, sessionId));
    },
    [commitLayoutState]
  );

  const pruneSessions = useCallback(
    (availableSessionIds: Set<string>, knownWorkspaceIds?: Set<string>) => {
      commitLayoutState((current) =>
        pruneUnavailableSessions(current, availableSessionIds, {
          knownWorkspaceIds,
        })
      );
    },
    [commitLayoutState]
  );

  const visibleRightSession = layoutState.rightSession;
  const isRightSessionPending =
    !visibleRightSession &&
    !!activeWorktreeId &&
    (isActiveWorkspaceLoading ||
      typeof activeWorkspaceWithSession === 'undefined');

  const value = useMemo<KanbanSessionContextValue>(
    () => ({
      panelView,
      activeViewId,
      setActiveViewId,
      setPanelView,
      goToBoard,
      goToSessionHub,
      goToUsageDashboard,
      isSessionHubVisible,
      setSessionHubVisible,
      toggleSessionHub,
      rightSession: layoutState.rightSession,
      visibleRightSession,
      isRightSessionPending,
      monitorSessions: layoutState.monitorSessions,
      lastActiveWorkspaceId,
      canUseRightPanelForSessions,
      isLayoutHydrated,
      openSessionFromList,
      placeCreatedSession: placeCreatedSessionInLayout,
      placeForkedChild: placeForkedChildInLayout,
      replaceRightSession: replaceRightSessionInLayout,
      activateExecutionSession,
      promoteMonitorSession,
      cancelMonitorSession,
      pruneSessions,
    }),
    [
      panelView,
      activeViewId,
      setActiveViewId,
      setPanelView,
      goToBoard,
      goToSessionHub,
      goToUsageDashboard,
      isSessionHubVisible,
      canUseRightPanelForSessions,
      isLayoutHydrated,
      lastActiveWorkspaceId,
      setSessionHubVisible,
      layoutState.monitorSessions,
      layoutState.rightSession,
      openSessionFromList,
      placeCreatedSessionInLayout,
      placeForkedChildInLayout,
      replaceRightSessionInLayout,
      activateExecutionSession,
      promoteMonitorSession,
      cancelMonitorSession,
      pruneSessions,
      toggleSessionHub,
      visibleRightSession,
      isRightSessionPending,
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
