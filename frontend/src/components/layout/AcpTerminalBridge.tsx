import { useEffect, useRef } from 'react';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { useWorktree } from '@/contexts/WorktreeContext';
import { tauriListen } from '@/lib/tauriApi';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  generateTerminalTabId,
  useTerminalStore,
} from '@/stores/useTerminalStore';

type AcpTerminalEvent =
  | {
      type: 'created';
      source: 'acp' | 'codex';
      session_id: string;
      workspace_id: string | null;
      title: string;
      command: string;
      cwd: string | null;
    }
  | {
      type: 'released';
      source: 'acp' | 'codex';
      session_id: string;
      workspace_id: string | null;
    };

export function AcpTerminalBridge() {
  const { activeWorktreeId } = useWorktree();
  const { openOrFocusPanel } = usePanelActionsContext();
  const addSession = useTerminalStore((state) => state.addSession);
  const setSessionId = useTerminalStore((state) => state.setSessionId);
  const removeSession = useTerminalStore((state) => state.removeSession);
  const activeWorktreeIdRef = useRef<string | null>(activeWorktreeId);
  const pendingSessionsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    activeWorktreeIdRef.current = activeWorktreeId;
  }, [activeWorktreeId]);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;
    const pendingSessions = pendingSessionsRef.current;

    void tauriListen<AcpTerminalEvent>('agent-terminal-events', (event) => {
      if (!mounted) return;

      const pendingKey = `${event.source}:${event.session_id}`;

      if (event.type === 'created') {
        if (pendingSessions.has(pendingKey)) {
          return;
        }

        const timerId = window.setTimeout(() => {
          pendingSessions.delete(pendingKey);
          if (!mounted) return;

          const workspaceId =
            event.workspace_id ?? activeWorktreeIdRef.current ?? null;
          if (!workspaceId) return;

          const existingSession = (
            useTerminalStore.getState().sessionsByWorkspace[workspaceId] ?? []
          ).find((session) => session.sessionId === event.session_id);
          if (existingSession) {
            return;
          }

          const tabId = generateTerminalTabId();
          addSession(workspaceId, tabId, undefined, {
            title: event.title,
            readOnly: true,
            source: event.source,
          });
          setSessionId(tabId, event.session_id);

          if (workspaceId === activeWorktreeIdRef.current) {
            openOrFocusPanel(PANEL_IDS.TERMINAL, 'Terminal');
          }
        }, 2000);

        pendingSessions.set(pendingKey, timerId);
        return;
      }

      const pendingTimerId = pendingSessions.get(pendingKey);
      if (pendingTimerId) {
        window.clearTimeout(pendingTimerId);
        pendingSessions.delete(pendingKey);
      }

      const targetWorkspaceIds = event.workspace_id
        ? [event.workspace_id]
        : Object.keys(useTerminalStore.getState().sessionsByWorkspace);

      for (const workspaceId of targetWorkspaceIds) {
        const matches = (
          useTerminalStore.getState().sessionsByWorkspace[workspaceId] ?? []
        ).filter((session) => session.sessionId === event.session_id);
        for (const session of matches) {
          removeSession(workspaceId, session.tabId);
        }
      }
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      mounted = false;
      for (const timerId of pendingSessions.values()) {
        window.clearTimeout(timerId);
      }
      pendingSessions.clear();
      unlisten?.();
    };
  }, [addSession, setSessionId, removeSession, openOrFocusPanel]);

  return null;
}
