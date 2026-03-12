import { create } from 'zustand';

/**
 * Terminal session metadata tracked per workspace.
 */
export interface TerminalSession {
  /** Unique tab ID (frontend-generated) */
  tabId: string;
  /** PTY session ID returned by Tauri backend */
  sessionId: string | null;
  /** Workspace ID this terminal belongs to */
  workspaceId: string;
  /** Display title for the terminal tab */
  title: string;
  /** Shell type override (e.g. 'powershell.exe', 'cmd.exe', 'bash') */
  shell?: string;
  /** Session type: 'pty' for normal terminal, 'log-viewer' for dev server logs */
  type?: 'pty' | 'log-viewer';
  /** ExecutionProcess ID — only used when type is 'log-viewer' */
  processId?: string;
}

interface TerminalState {
  /** Terminal sessions grouped by workspace ID */
  sessionsByWorkspace: Record<string, TerminalSession[]>;
  /** Active terminal tab ID per workspace */
  activeTabByWorkspace: Record<string, string | null>;

  /** Add a new terminal session for a workspace */
  addSession: (workspaceId: string, tabId: string, shell?: string, options?: { title?: string; type?: 'pty' | 'log-viewer'; processId?: string }) => void;
  /** Set the PTY session ID once the backend creates it */
  setSessionId: (tabId: string, sessionId: string) => void;
  /** Remove a terminal session */
  removeSession: (workspaceId: string, tabId: string) => void;
  /** Set the active tab for a workspace */
  setActiveTab: (workspaceId: string, tabId: string | null) => void;
  /** Update the title of a terminal tab */
  updateTitle: (tabId: string, title: string) => void;
  /** Clear all sessions for a workspace */
  clearWorkspace: (workspaceId: string) => void;
  /** Get sessions for a specific workspace */
  getSessionsForWorkspace: (workspaceId: string) => TerminalSession[];
}

let tabCounter = 0;

export function generateTerminalTabId(): string {
  tabCounter += 1;
  return `term-${Date.now()}-${tabCounter}`;
}

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  sessionsByWorkspace: {},
  activeTabByWorkspace: {},

  addSession: (workspaceId, tabId, shell, options) => {
    const state = get();
    const existing = state.sessionsByWorkspace[workspaceId] || [];
    const session: TerminalSession = {
      tabId,
      sessionId: null,
      workspaceId,
      title: options?.title ?? (options?.type === 'log-viewer' ? `日志 ${existing.length + 1}` : `终端 ${existing.length + 1}`),
      shell,
      type: options?.type ?? 'pty',
      processId: options?.processId,
    };
    set({
      sessionsByWorkspace: {
        ...state.sessionsByWorkspace,
        [workspaceId]: [...existing, session],
      },
      activeTabByWorkspace: {
        ...state.activeTabByWorkspace,
        [workspaceId]: tabId,
      },
    });
  },

  setSessionId: (tabId, sessionId) => {
    const state = get();
    const updated: Record<string, TerminalSession[]> = {};
    for (const [wsId, sessions] of Object.entries(
      state.sessionsByWorkspace
    )) {
      updated[wsId] = sessions.map((s) =>
        s.tabId === tabId ? { ...s, sessionId } : s
      );
    }
    set({ sessionsByWorkspace: updated });
  },

  removeSession: (workspaceId, tabId) => {
    const state = get();
    const sessions = state.sessionsByWorkspace[workspaceId] || [];
    const newSessions = sessions.filter((s) => s.tabId !== tabId);
    const wasActive = state.activeTabByWorkspace[workspaceId] === tabId;

    let newActive = state.activeTabByWorkspace[workspaceId];
    if (wasActive && newSessions.length > 0) {
      const closedIdx = sessions.findIndex((s) => s.tabId === tabId);
      const nextIdx = Math.min(closedIdx, newSessions.length - 1);
      newActive = newSessions[nextIdx]?.tabId ?? null;
    } else if (newSessions.length === 0) {
      newActive = null;
    }

    set({
      sessionsByWorkspace: {
        ...state.sessionsByWorkspace,
        [workspaceId]: newSessions,
      },
      activeTabByWorkspace: {
        ...state.activeTabByWorkspace,
        [workspaceId]: newActive,
      },
    });
  },

  setActiveTab: (workspaceId, tabId) => {
    set((s) => ({
      activeTabByWorkspace: {
        ...s.activeTabByWorkspace,
        [workspaceId]: tabId,
      },
    }));
  },

  updateTitle: (tabId, title) => {
    const state = get();
    const updated: Record<string, TerminalSession[]> = {};
    for (const [wsId, sessions] of Object.entries(
      state.sessionsByWorkspace
    )) {
      updated[wsId] = sessions.map((s) =>
        s.tabId === tabId ? { ...s, title } : s
      );
    }
    set({ sessionsByWorkspace: updated });
  },

  clearWorkspace: (workspaceId) => {
    const state = get();
    const { [workspaceId]: _removed, ...restSessions } =
      state.sessionsByWorkspace;
    const { [workspaceId]: _removedActive, ...restActive } =
      state.activeTabByWorkspace;
    set({
      sessionsByWorkspace: restSessions,
      activeTabByWorkspace: restActive,
    });
  },

  getSessionsForWorkspace: (workspaceId) => {
    return get().sessionsByWorkspace[workspaceId] || [];
  },
}));
