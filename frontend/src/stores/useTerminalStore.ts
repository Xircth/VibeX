import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  /** Whether this terminal should reject user input */
  readOnly?: boolean;
  /** Logical source of the terminal session */
  source?: 'workspace' | 'acp' | 'codex' | 'log-viewer';
}

interface TerminalState {
  /** Terminal sessions grouped by workspace ID */
  sessionsByWorkspace: Record<string, TerminalSession[]>;
  /** Active terminal tab ID per workspace */
  activeTabByWorkspace: Record<string, string | null>;

  /** Add a new terminal session for a workspace */
  addSession: (
    workspaceId: string,
    tabId: string,
    shell?: string,
    options?: {
      title?: string;
      type?: 'pty' | 'log-viewer';
      processId?: string;
      readOnly?: boolean;
      source?: 'workspace' | 'acp' | 'codex' | 'log-viewer';
    }
  ) => void;
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

function formatTerminalTitle(index: number): string {
  return `VU-${String(index).padStart(2, '0')}`;
}

export function generateTerminalTabId(): string {
  tabCounter += 1;
  return `term-${Date.now()}-${tabCounter}`;
}

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      sessionsByWorkspace: {},
      activeTabByWorkspace: {},

      addSession: (workspaceId, tabId, shell, options) => {
        const state = get();
        const existing = state.sessionsByWorkspace[workspaceId] || [];
        const session: TerminalSession = {
          tabId,
          sessionId: null,
          workspaceId,
          title:
            options?.title ??
            (options?.type === 'log-viewer'
              ? `Log ${existing.length + 1}`
              : formatTerminalTitle(existing.length + 1)),
          shell,
          type: options?.type ?? 'pty',
          processId: options?.processId,
          readOnly: options?.readOnly ?? false,
          source:
            options?.source ??
            (options?.type === 'log-viewer' ? 'log-viewer' : 'workspace'),
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
          updated[wsId] = sessions.map((session) =>
            session.tabId === tabId ? { ...session, sessionId } : session
          );
        }
        set({ sessionsByWorkspace: updated });
      },

      removeSession: (workspaceId, tabId) => {
        const state = get();
        const sessions = state.sessionsByWorkspace[workspaceId] || [];
        const newSessions = sessions.filter((session) => session.tabId !== tabId);
        const wasActive = state.activeTabByWorkspace[workspaceId] === tabId;

        let newActive = state.activeTabByWorkspace[workspaceId];
        if (wasActive && newSessions.length > 0) {
          const closedIdx = sessions.findIndex((session) => session.tabId === tabId);
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
        set((state) => ({
          activeTabByWorkspace: {
            ...state.activeTabByWorkspace,
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
          updated[wsId] = sessions.map((session) =>
            session.tabId === tabId ? { ...session, title } : session
          );
        }
        set({ sessionsByWorkspace: updated });
      },

      clearWorkspace: (workspaceId) => {
        const state = get();
        const restSessions = { ...state.sessionsByWorkspace };
        delete restSessions[workspaceId];
        const restActive = { ...state.activeTabByWorkspace };
        delete restActive[workspaceId];
        set({
          sessionsByWorkspace: restSessions,
          activeTabByWorkspace: restActive,
        });
      },

      getSessionsForWorkspace: (workspaceId) => {
        return get().sessionsByWorkspace[workspaceId] || [];
      },
    }),
    {
      name: 'vibe-ultra-terminal-sessions',
      version: 2,
      migrate: (persistedState) => {
        const state = (persistedState ?? {}) as Partial<TerminalState>;
        const sessionsByWorkspace = Object.fromEntries(
          Object.entries(state.sessionsByWorkspace ?? {}).map(
            ([workspaceId, sessions]) => [
              workspaceId,
              (sessions ?? []).filter(
                (session) =>
                  !session.readOnly &&
                  session.source !== 'acp' &&
                  session.source !== 'codex'
              ),
            ]
          )
        );

        const activeTabByWorkspace = Object.fromEntries(
          Object.entries(state.activeTabByWorkspace ?? {}).map(
            ([workspaceId, activeTabId]) => {
              const sessions = sessionsByWorkspace[workspaceId] ?? [];
              const nextActiveTab = sessions.some(
                (session) => session.tabId === activeTabId
              )
                ? activeTabId
                : (sessions[0]?.tabId ?? null);
              return [workspaceId, nextActiveTab];
            }
          )
        );

        return {
          sessionsByWorkspace,
          activeTabByWorkspace,
        };
      },
      partialize: (state) => ({
        sessionsByWorkspace: Object.fromEntries(
          Object.entries(state.sessionsByWorkspace).map(
            ([workspaceId, sessions]) => [
              workspaceId,
              sessions.filter(
                (session) =>
                  !session.readOnly &&
                  session.source !== 'acp' &&
                  session.source !== 'codex'
              ),
            ]
          )
        ),
        activeTabByWorkspace: Object.fromEntries(
          Object.entries(state.activeTabByWorkspace).map(
            ([workspaceId, activeTabId]) => {
              const persistedSessions =
                state.sessionsByWorkspace[workspaceId]?.filter(
                  (session) =>
                    !session.readOnly &&
                    session.source !== 'acp' &&
                    session.source !== 'codex'
                ) ?? [];
              const nextActiveTab = persistedSessions.some(
                (session) => session.tabId === activeTabId
              )
                ? activeTabId
                : (persistedSessions[0]?.tabId ?? null);
              return [workspaceId, nextActiveTab];
            }
          )
        ),
      }),
    }
  )
);
