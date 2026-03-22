import { useEffect } from 'react';
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
      session_id: string;
      workspace_id: string | null;
      command: string;
      cwd: string | null;
    }
  | {
      type: 'released';
      session_id: string;
      workspace_id: string | null;
    };

export function AcpTerminalBridge() {
  const { activeWorktreeId } = useWorktree();
  const { openOrFocusPanel } = usePanelActionsContext();
  const addSession = useTerminalStore((state) => state.addSession);
  const setSessionId = useTerminalStore((state) => state.setSessionId);
  const removeSession = useTerminalStore((state) => state.removeSession);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | null = null;

    void tauriListen<AcpTerminalEvent>('acp-terminal-events', (event) => {
      if (!mounted) return;

      if (event.type === 'created') {
        const workspaceId = event.workspace_id ?? activeWorktreeId;
        if (!workspaceId) return;

        const existingSession = (
          useTerminalStore.getState().sessionsByWorkspace[workspaceId] ?? []
        ).find((session) => session.sessionId === event.session_id);
        if (!existingSession) {
          const tabId = generateTerminalTabId();
          addSession(workspaceId, tabId, undefined, {
            readOnly: true,
            source: 'acp',
          });
          setSessionId(tabId, event.session_id);
        }

        if (workspaceId === activeWorktreeId) {
          openOrFocusPanel(PANEL_IDS.TERMINAL, 'Terminal');
        }
        return;
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
      unlisten?.();
    };
  }, [
    activeWorktreeId,
    addSession,
    setSessionId,
    removeSession,
    openOrFocusPanel,
  ]);

  return null;
}
