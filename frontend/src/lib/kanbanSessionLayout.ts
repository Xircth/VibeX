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
  activeWorkspaceSession: KanbanSessionPlacement | null
): KanbanSessionPlacement | null {
  return rightSession ?? activeWorkspaceSession;
}

export function pruneUnavailableSessions(
  state: KanbanSessionLayoutState,
  availableSessionIds: Set<string>
): KanbanSessionLayoutState {
  const rightSession =
    state.rightSession && availableSessionIds.has(state.rightSession.sessionId)
      ? state.rightSession
      : null;

  const monitorSessions = state.monitorSessions.filter((session) =>
    availableSessionIds.has(session.sessionId)
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
