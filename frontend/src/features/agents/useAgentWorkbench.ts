import { useCallback, useEffect, useReducer, useState } from 'react';
import { tauriListen } from '@/lib/tauriApi';
import { agentsApi } from './api';
import {
  emptyAgentWorkbenchState,
  hydrateAgentSnapshot,
  reduceAgentEvent,
} from './store';
import type {
  AgentCancelPromptRequest,
  AgentConnectRequest,
  AgentNewSessionRequest,
  AgentSendPromptRequest,
} from './api';
import type {
  AgentEventEnvelope,
  AgentRuntimeSnapshot,
} from './types';

export const AGENT_EVENTS_CHANNEL = 'agent-events';

type AgentWorkbenchAction =
  | { type: 'hydrate'; snapshot: AgentRuntimeSnapshot }
  | { type: 'event'; envelope: AgentEventEnvelope };

type AgentWorkbenchLoadState = 'loading' | 'ready' | 'error';

function agentWorkbenchReducer(
  state: ReturnType<typeof emptyAgentWorkbenchState>,
  action: AgentWorkbenchAction
) {
  switch (action.type) {
    case 'hydrate':
      return hydrateAgentSnapshot(state, action.snapshot);
    case 'event':
      return reduceAgentEvent(state, action.envelope);
  }
}

export function useAgentWorkbench() {
  const [state, dispatch] = useReducer(
    agentWorkbenchReducer,
    undefined,
    emptyAgentWorkbenchState
  );
  const [loadState, setLoadState] =
    useState<AgentWorkbenchLoadState>('loading');
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    const snapshot = await agentsApi.snapshot();
    dispatch({ type: 'hydrate', snapshot });
    setLoadState('ready');
    setError(null);
    return snapshot;
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    tauriListen<AgentEventEnvelope>(AGENT_EVENTS_CHANNEL, (envelope) => {
      dispatch({ type: 'event', envelope });
    })
      .then((unlistenAgentEvents) => {
        if (!active) {
          unlistenAgentEvents();
          return undefined;
        }

        unlisten = unlistenAgentEvents;
        return refresh();
      })
      .catch((caught) => {
        if (!active) return;
        setLoadState('error');
        setError(caught);
      });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [refresh]);

  const connect = useCallback((request: AgentConnectRequest) => {
    return agentsApi.connect(request);
  }, []);

  const newSession = useCallback((request: AgentNewSessionRequest) => {
    return agentsApi.newSession(request);
  }, []);

  const sendPrompt = useCallback((request: AgentSendPromptRequest) => {
    return agentsApi.sendPrompt(request);
  }, []);

  const cancelPrompt = useCallback((request: AgentCancelPromptRequest) => {
    return agentsApi.cancelPrompt(request);
  }, []);

  return {
    ...state,
    loadState,
    error,
    refresh,
    connect,
    newSession,
    sendPrompt,
    cancelPrompt,
  };
}
