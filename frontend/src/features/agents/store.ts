import type {
  AgentConnectionSnapshot,
  AgentEventEnvelope,
  AgentPermissionRequest,
  AgentPromptSnapshot,
  AgentRegistryEntry,
  AgentRuntimeSnapshot,
  AgentSessionSnapshot,
  AgentTerminalSnapshot,
} from './types';

export type AgentWorkbenchState = {
  registry: Record<string, AgentRegistryEntry>;
  connections: Record<string, AgentConnectionSnapshot>;
  sessions: Record<string, AgentSessionSnapshot>;
  prompts: Record<string, AgentPromptSnapshot>;
  permissions: Record<string, AgentPermissionRequest>;
  terminals: Record<string, AgentTerminalSnapshot>;
  usageByScope: Record<string, { used: number; limit?: number | null }>;
  errorsByScope: Record<string, string[]>;
  eventsByScope: Record<string, AgentEventEnvelope[]>;
  lastSequence: number;
};

export function emptyAgentWorkbenchState(): AgentWorkbenchState {
  return {
    registry: {},
    connections: {},
    sessions: {},
    prompts: {},
    permissions: {},
    terminals: {},
    usageByScope: {},
    errorsByScope: {},
    eventsByScope: {},
    lastSequence: 0,
  };
}

export function stateFromAgentSnapshot(
  snapshot: AgentRuntimeSnapshot
): AgentWorkbenchState {
  return {
    registry: Object.fromEntries(
      snapshot.registry.map((entry) => [entry.registry_id, entry])
    ),
    connections: Object.fromEntries(
      snapshot.connections.map((connection) => [connection.id, connection])
    ),
    sessions: Object.fromEntries(
      snapshot.sessions.map((session) => [session.id, session])
    ),
    prompts: Object.fromEntries(
      snapshot.prompts.map((prompt) => [prompt.id, prompt])
    ),
    permissions: {},
    terminals: {},
    usageByScope: {},
    errorsByScope: {},
    eventsByScope: snapshot.events.reduce(
      (eventsByScope, envelope) => appendEvent(eventsByScope, envelope),
      {} as Record<string, AgentEventEnvelope[]>
    ),
    lastSequence: snapshot.sequence,
  };
}

export function hydrateAgentSnapshot(
  state: AgentWorkbenchState,
  snapshot: AgentRuntimeSnapshot
): AgentWorkbenchState {
  if (snapshot.sequence < state.lastSequence) {
    return state;
  }

  return stateFromAgentSnapshot(snapshot);
}

export function reduceAgentEvent(
  state: AgentWorkbenchState,
  envelope: AgentEventEnvelope
): AgentWorkbenchState {
  if (envelope.sequence <= state.lastSequence) {
    return state;
  }

  const next: AgentWorkbenchState = {
    registry: state.registry,
    connections: state.connections,
    sessions: state.sessions,
    prompts: state.prompts,
    permissions: state.permissions,
    terminals: state.terminals,
    usageByScope: state.usageByScope,
    errorsByScope: state.errorsByScope,
    eventsByScope: appendEvent(state.eventsByScope, envelope),
    lastSequence: envelope.sequence,
  };

  switch (envelope.event.kind) {
    case 'connection_status_changed':
      next.connections = {
        ...state.connections,
        [envelope.event.snapshot.id]: envelope.event.snapshot,
      };
      return next;
    case 'session_created':
      next.sessions = {
        ...state.sessions,
        [envelope.event.snapshot.id]: envelope.event.snapshot,
      };
      return next;
    case 'prompt_started':
      next.prompts = {
        ...state.prompts,
        [envelope.event.snapshot.id]: envelope.event.snapshot,
      };
      return next;
    case 'prompt_finished': {
      const prompt = state.prompts[envelope.event.finished.prompt_id];
      if (!prompt) return next;
      next.prompts = {
        ...state.prompts,
        [prompt.id]: {
          ...prompt,
          status: {
            kind: 'completed',
            stop_reason: envelope.event.finished.stop_reason ?? null,
          },
        },
      };
      return next;
    }
    case 'permission_requested':
      next.permissions = {
        ...state.permissions,
        [envelope.event.request.id]: envelope.event.request,
      };
      return next;
    case 'permission_responded': {
      const { [envelope.event.permission_id]: _removed, ...permissions } =
        state.permissions;
      next.permissions = permissions;
      return next;
    }
    case 'terminal_created':
      next.terminals = {
        ...state.terminals,
        [envelope.event.terminal.id]: envelope.event.terminal,
      };
      return next;
    case 'usage':
      next.usageByScope = {
        ...state.usageByScope,
        [scopeId(envelope)]: envelope.event.usage,
      };
      return next;
    case 'error':
      next.errorsByScope = {
        ...state.errorsByScope,
        [scopeId(envelope)]: [
          ...(state.errorsByScope[scopeId(envelope)] ?? []),
          envelope.event.error.message,
        ],
      };
      return next;
    default:
      return next;
  }
}

function scopeId(envelope: AgentEventEnvelope): string {
  return envelope.session_id ?? envelope.connection_id;
}

function appendEvent(
  eventsByScope: Record<string, AgentEventEnvelope[]>,
  envelope: AgentEventEnvelope
): Record<string, AgentEventEnvelope[]> {
  return {
    ...eventsByScope,
    [scopeId(envelope)]: [
      ...(eventsByScope[scopeId(envelope)] ?? []),
      envelope,
    ],
  };
}
