import { useEffect } from 'react';
import { backendCall, backendListen } from '@/lib/backendTransport';
import {
  generateTerminalTabId,
  useTerminalStore,
} from '@/stores/useTerminalStore';
import { useAgentCommandOutputStore } from '@/stores/useAgentCommandOutputStore';
import { nextAgentTerminalTitle } from '@/lib/agentTerminalTitles';
import { agentCommandCapturesFromTurn } from '@/lib/agentCommandCapture';
import { listenToConversationEvents } from '@/features/conversation/events';
import { sessionsApi } from '@/lib/api';
import type { ConversationRowOpBatch } from 'shared/types';

type AgentTerminalUiEvent =
  | {
      type: 'created';
      session_id: string;
      agent_session_id?: string;
      workspace_id?: string | null;
      title: string;
      command: string;
      agent_label?: string;
      cwd?: string | null;
    }
  | {
      type: 'exited';
      session_id: string;
      workspace_id?: string | null;
    }
  | {
      type: 'released';
      session_id: string;
      workspace_id?: string | null;
    };

type AgentLiveTerminalView = {
  terminalId: string;
  agentSessionId: string;
  command: string;
  args: string[];
  cwd?: string | null;
};

function removeAgentTerminal(terminalId: string) {
  const store = useTerminalStore.getState();
  for (const [workspaceId, sessions] of Object.entries(
    store.sessionsByWorkspace
  )) {
    const match = sessions.find(
      (session) => session.source === 'acp' && session.sessionId === terminalId
    );
    if (match) {
      store.removeSession(workspaceId, match.tabId);
    }
  }
}

async function resolveAgentLabel(
  eventLabel: string | undefined,
  agentSessionId: string | undefined
): Promise<string> {
  if (eventLabel && eventLabel !== 'Agent') {
    return eventLabel;
  }
  if (!agentSessionId) {
    return 'Agent';
  }
  try {
    const session = await sessionsApi.getById(agentSessionId);
    return session.agent_id ?? session.executor ?? 'Agent';
  } catch {
    return eventLabel ?? 'Agent';
  }
}

function upsertAgentTerminal(input: {
  terminalId: string;
  workspaceId: string;
  agentLabel: string;
  command: string;
  type?: 'pty' | 'agent-command';
}) {
  const store = useTerminalStore.getState();
  const existing = store.getSessionsForWorkspace(input.workspaceId);
  if (
    existing.some(
      (session) =>
        session.source === 'acp' && session.sessionId === input.terminalId
    )
  ) {
    return;
  }

  const title = nextAgentTerminalTitle(
    input.agentLabel,
    existing.map((session) => session.title)
  );
  store.addSession(input.workspaceId, generateTerminalTabId(), undefined, {
    title,
    source: 'acp',
    readOnly: true,
    sessionId: input.terminalId,
    type: input.type,
  });
}

function applyConversationBatch(batch: ConversationRowOpBatch) {
  for (const op of batch.ops) {
    if (op.op !== 'upsert' || op.row.row.kind !== 'message_turn') {
      continue;
    }
    const captures = agentCommandCapturesFromTurn(op.row.row.turn);
    if (captures.length === 0) {
      continue;
    }
    void sessionsApi
      .getById(batch.conversation_id)
      .then((session) => {
        for (const capture of captures) {
          if (capture.running) {
            if (capture.output) {
              useAgentCommandOutputStore
                .getState()
                .setOutput(capture.toolUseId, capture.output);
            }
            upsertAgentTerminal({
              terminalId: capture.toolUseId,
              workspaceId: session.workspace_id,
              agentLabel: session.agent_id ?? session.executor ?? 'Agent',
              command: capture.command,
              type: 'agent-command',
            });
          } else {
            useAgentCommandOutputStore.getState().clear(capture.toolUseId);
            removeAgentTerminal(capture.toolUseId);
          }
        }
      })
      .catch(() => {
        // Conversation may not map to a session yet.
      });
  }
}

export function useAgentLongRunningTerminals() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let unlistenConversation: (() => void) | undefined;

    const handleEvent = (event: AgentTerminalUiEvent) => {
      if (event.type === 'created') {
        if (!event.workspace_id) {
          return;
        }
        void resolveAgentLabel(event.agent_label, event.agent_session_id).then(
          (agentLabel) => {
            if (cancelled || !event.workspace_id) {
              return;
            }
            upsertAgentTerminal({
              terminalId: event.session_id,
              workspaceId: event.workspace_id,
              agentLabel,
              command: event.command,
            });
          }
        );
        return;
      }

      removeAgentTerminal(event.session_id);
    };

    void (async () => {
      try {
        unlisten = await backendListen<AgentTerminalUiEvent>(
          'agent-terminal-events',
          handleEvent
        );
        unlistenConversation = await listenToConversationEvents((batch) => {
          if (!cancelled) {
            applyConversationBatch(batch);
          }
        });
        const live = await backendCall<AgentLiveTerminalView[]>(
          'agent_list_live_terminals'
        );
        if (cancelled) {
          return;
        }
        for (const item of live) {
          try {
            const session = await sessionsApi.getById(item.agentSessionId);
            if (cancelled) {
              return;
            }
            upsertAgentTerminal({
              terminalId: item.terminalId,
              workspaceId: session.workspace_id,
              agentLabel: session.agent_id ?? session.executor ?? 'Agent',
              command: [item.command, ...item.args].join(' '),
            });
          } catch {
            // Session may have been removed while the terminal is still live.
          }
        }
      } catch {
        // Best-effort: the terminal panel still works without agent tabs.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenConversation?.();
    };
  }, []);
}
