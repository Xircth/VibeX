export interface KanbanSessionPlacement {
  sessionId: string;
  workspaceId: string;
}

export interface KanbanSessionLayoutState {
  rightSession: KanbanSessionPlacement | null;
  monitorSessions: KanbanSessionPlacement[];
}

export interface KanbanSessionPlacementOptions {
  canUseRightPanel: boolean;
}

export const MAX_MONITORED_KANBAN_SESSIONS = 4;

export function createEmptyKanbanSessionLayoutState(): KanbanSessionLayoutState {
  return {
    rightSession: null,
    monitorSessions: [],
  };
}

export function isSameKanbanSession(
  left: KanbanSessionPlacement | null | undefined,
  right: KanbanSessionPlacement | null | undefined
): boolean {
  return !!left && !!right && left.sessionId === right.sessionId;
}

function withoutSession(
  sessions: KanbanSessionPlacement[],
  sessionId: string
): KanbanSessionPlacement[] {
  return sessions.filter((session) => session.sessionId !== sessionId);
}

export function appendMonitorSession(
  sessions: KanbanSessionPlacement[],
  nextSession: KanbanSessionPlacement
): KanbanSessionPlacement[] {
  const deduped = withoutSession(sessions, nextSession.sessionId);
  const appended = [...deduped, nextSession];

  if (appended.length <= MAX_MONITORED_KANBAN_SESSIONS) {
    return appended;
  }

  return appended.slice(appended.length - MAX_MONITORED_KANBAN_SESSIONS);
}

export function placeSessionFromList(
  state: KanbanSessionLayoutState,
  nextSession: KanbanSessionPlacement,
  options: KanbanSessionPlacementOptions
): KanbanSessionLayoutState {
  if (isSameKanbanSession(state.rightSession, nextSession)) {
    return state;
  }

  if (options.canUseRightPanel && !state.rightSession) {
    return {
      rightSession: nextSession,
      monitorSessions: withoutSession(
        state.monitorSessions,
        nextSession.sessionId
      ),
    };
  }

  return {
    ...state,
    monitorSessions: appendMonitorSession(state.monitorSessions, nextSession),
  };
}

export function placeForkedChild(
  state: KanbanSessionLayoutState,
  child: KanbanSessionPlacement,
  parentSessionId: string | null,
  options: KanbanSessionPlacementOptions
): KanbanSessionLayoutState {
  const dropParent = (sessions: KanbanSessionPlacement[]) =>
    parentSessionId ? withoutSession(sessions, parentSessionId) : sessions;

  if (!options.canUseRightPanel) {
    return {
      rightSession:
        parentSessionId && state.rightSession?.sessionId === parentSessionId
          ? child
          : state.rightSession,
      monitorSessions: appendMonitorSession(
        dropParent(withoutSession(state.monitorSessions, child.sessionId)),
        child
      ),
    };
  }

  return {
    rightSession: child,
    monitorSessions: dropParent(
      withoutSession(state.monitorSessions, child.sessionId)
    ),
  };
}

export function placeCreatedSession(
  state: KanbanSessionLayoutState,
  nextSession: KanbanSessionPlacement,
  options: KanbanSessionPlacementOptions
): KanbanSessionLayoutState {
  if (!options.canUseRightPanel) {
    return {
      ...state,
      monitorSessions: appendMonitorSession(state.monitorSessions, nextSession),
    };
  }

  if (!state.rightSession) {
    return {
      rightSession: nextSession,
      monitorSessions: withoutSession(
        state.monitorSessions,
        nextSession.sessionId
      ),
    };
  }

  return {
    rightSession: nextSession,
    monitorSessions: appendMonitorSession(
      withoutSession(state.monitorSessions, nextSession.sessionId),
      state.rightSession
    ),
  };
}

export function promoteMonitorSessionToRight(
  state: KanbanSessionLayoutState,
  sessionId: string,
  options: KanbanSessionPlacementOptions
): KanbanSessionLayoutState {
  if (!options.canUseRightPanel) {
    return state;
  }

  const targetSession = state.monitorSessions.find(
    (session) => session.sessionId === sessionId
  );

  if (!targetSession) {
    return state;
  }

  const remainingMonitorSessions = withoutSession(
    state.monitorSessions,
    sessionId
  );

  if (!state.rightSession) {
    return {
      rightSession: targetSession,
      monitorSessions: remainingMonitorSessions,
    };
  }

  return {
    rightSession: targetSession,
    monitorSessions: appendMonitorSession(
      remainingMonitorSessions,
      state.rightSession
    ),
  };
}

/**
 * Put a notification's session in the execution area. If the target is already
 * monitored this is a true promotion; otherwise the target and the current
 * execution session exchange places so both remain represented in the layout.
 */
export function activateSessionInExecutionArea(
  state: KanbanSessionLayoutState,
  nextSession: KanbanSessionPlacement,
  options: KanbanSessionPlacementOptions
): KanbanSessionLayoutState {
  if (
    !options.canUseRightPanel ||
    isSameKanbanSession(state.rightSession, nextSession)
  ) {
    return state;
  }

  if (
    state.monitorSessions.some(
      (session) => session.sessionId === nextSession.sessionId
    )
  ) {
    return promoteMonitorSessionToRight(state, nextSession.sessionId, options);
  }

  return {
    rightSession: nextSession,
    monitorSessions: state.rightSession
      ? appendMonitorSession(
          withoutSession(state.monitorSessions, nextSession.sessionId),
          state.rightSession
        )
      : withoutSession(state.monitorSessions, nextSession.sessionId),
  };
}

export function removeMonitorSession(
  state: KanbanSessionLayoutState,
  sessionId: string
): KanbanSessionLayoutState {
  const monitorSessions = withoutSession(state.monitorSessions, sessionId);

  if (monitorSessions.length === state.monitorSessions.length) {
    return state;
  }

  return {
    ...state,
    monitorSessions,
  };
}

export function replaceRightSession(
  state: KanbanSessionLayoutState,
  nextSession: KanbanSessionPlacement,
  options: KanbanSessionPlacementOptions
): KanbanSessionLayoutState {
  if (!options.canUseRightPanel) {
    return state;
  }

  if (isSameKanbanSession(state.rightSession, nextSession)) {
    return state;
  }

  return {
    rightSession: nextSession,
    monitorSessions: withoutSession(
      state.monitorSessions,
      nextSession.sessionId
    ),
  };
}

export function resolveCurrentExecutionPlacement(
  rightSession: KanbanSessionPlacement | null,
  activeWorkspaceSession: KanbanSessionPlacement | null,
  options: { canUseRightPanel: boolean }
): KanbanSessionPlacement | null {
  if (!options.canUseRightPanel) {
    return null;
  }

  return rightSession ?? activeWorkspaceSession;
}

export function shouldPruneKanbanSessionPlacements(input: {
  isLayoutHydrated: boolean;
  isLoading: boolean;
  availableSessionCount: number;
}): boolean {
  if (!input.isLayoutHydrated || input.isLoading) {
    return false;
  }

  // An empty available set is not evidence that placements are gone —
  // workspace streams can emit an empty snapshot before sessions arrive.
  return input.availableSessionCount > 0;
}

export function pruneUnavailableSessions(
  state: KanbanSessionLayoutState,
  availableSessionIds: Set<string>,
  options?: { knownWorkspaceIds?: Set<string> }
): KanbanSessionLayoutState {
  const isUnavailable = (placement: KanbanSessionPlacement) => {
    if (availableSessionIds.has(placement.sessionId)) {
      return false;
    }

    // A workspace missing from the current snapshot is not evidence the
    // session is gone — streams can emit a partial workspace list first.
    if (
      options?.knownWorkspaceIds &&
      !options.knownWorkspaceIds.has(placement.workspaceId)
    ) {
      return false;
    }

    return true;
  };

  const rightSession =
    state.rightSession && !isUnavailable(state.rightSession)
      ? state.rightSession
      : null;

  const monitorSessions = state.monitorSessions.filter(
    (session) => !isUnavailable(session)
  );

  if (
    isSameKanbanSession(rightSession, state.rightSession) &&
    monitorSessions.length === state.monitorSessions.length
  ) {
    return state;
  }

  return {
    rightSession,
    monitorSessions,
  };
}
