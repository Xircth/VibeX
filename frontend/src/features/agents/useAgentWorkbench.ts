import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import { agentsApi } from './api';
import { listenToAgentEvents } from './events';
import {
  emptyAgentWorkbenchState,
  hydrateAgentSnapshot,
  reduceAgentEvent,
  type AgentWorkbenchState,
} from './store';
import type {
  AgentCancelPromptRequest,
  AgentConnectRequest,
  AgentNewSessionRequest,
  AgentRespondPermissionRequest,
  AgentSendPromptRequest,
} from './api';
import type {
  AgentConnectionSnapshot,
  AgentPromptSnapshot,
  AgentRuntimeSnapshot,
  AgentSessionSnapshot,
} from './types';

type AgentWorkbenchAction =
  | { type: 'hydrate'; snapshot: AgentRuntimeSnapshot }
  | { type: 'event'; envelope: import('./types').AgentEventEnvelope };

type AgentWorkbenchLoadState = 'loading' | 'ready' | 'error';

export interface AgentWorkbench extends AgentWorkbenchState {
  loadState: AgentWorkbenchLoadState;
  error: unknown;
  refresh: () => Promise<AgentRuntimeSnapshot>;
  connect: (request: AgentConnectRequest) => Promise<AgentConnectionSnapshot>;
  newSession: (
    request: AgentNewSessionRequest
  ) => Promise<AgentSessionSnapshot>;
  sendPrompt: (
    request: AgentSendPromptRequest
  ) => Promise<AgentPromptSnapshot>;
  cancelPrompt: (request: AgentCancelPromptRequest) => Promise<void>;
  respondPermission: (
    request: AgentRespondPermissionRequest
  ) => Promise<void>;
}

function agentWorkbenchReducer(
  state: AgentWorkbenchState,
  action: AgentWorkbenchAction
): AgentWorkbenchState {
  switch (action.type) {
    case 'hydrate':
      return hydrateAgentSnapshot(state, action.snapshot);
    case 'event':
      return reduceAgentEvent(state, action.envelope);
  }
}

/**
 * The live agent runtime store. Holds one reducer and one `agent-events`
 * subscription for runtime/debug state. Product conversation history is read
 * from the durable `conversation-events` log.
 */
function useAgentWorkbenchStore(): AgentWorkbench {
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

    listenToAgentEvents((envelope) => {
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

  const connect = useCallback(
    (request: AgentConnectRequest) => agentsApi.connect(request),
    []
  );
  const newSession = useCallback(
    (request: AgentNewSessionRequest) => agentsApi.newSession(request),
    []
  );
  const sendPrompt = useCallback(
    (request: AgentSendPromptRequest) => agentsApi.sendPrompt(request),
    []
  );
  const cancelPrompt = useCallback(
    (request: AgentCancelPromptRequest) => agentsApi.cancelPrompt(request),
    []
  );
  const respondPermission = useCallback(
    (request: AgentRespondPermissionRequest) =>
      agentsApi.respondPermission(request),
    []
  );

  return useMemo(
    () => ({
      ...state,
      loadState,
      error,
      refresh,
      connect,
      newSession,
      sendPrompt,
      cancelPrompt,
      respondPermission,
    }),
    [
      state,
      loadState,
      error,
      refresh,
      connect,
      newSession,
      sendPrompt,
      cancelPrompt,
      respondPermission,
    ]
  );
}

const AgentWorkbenchContext = createContext<AgentWorkbench | null>(null);

export function AgentWorkbenchProvider({ children }: { children: ReactNode }) {
  const workbench = useAgentWorkbenchStore();
  return createElement(
    AgentWorkbenchContext.Provider,
    { value: workbench },
    children
  );
}

// Stable empty fallback used when no provider is mounted (isolated tests /
// standalone renders). No subscription, no live data — methods still proxy the
// stateless tauri commands so callers don't crash.
const EMPTY_WORKBENCH: AgentWorkbench = {
  ...emptyAgentWorkbenchState(),
  loadState: 'ready',
  error: null,
  refresh: () => agentsApi.snapshot(),
  connect: (request) => agentsApi.connect(request),
  newSession: (request) => agentsApi.newSession(request),
  sendPrompt: (request) => agentsApi.sendPrompt(request),
  cancelPrompt: (request) => agentsApi.cancelPrompt(request),
  respondPermission: (request) => agentsApi.respondPermission(request),
};

export function useAgentWorkbench(): AgentWorkbench {
  return useContext(AgentWorkbenchContext) ?? EMPTY_WORKBENCH;
}
