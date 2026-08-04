import type {
  AgentAvailableCommand,
  AgentConnectionSnapshot,
  AgentEventEnvelope,
  AgentPermissionRequest,
  AgentPromptSnapshot,
  AgentRuntimeSnapshot,
  AgentSessionConfigOption,
  AgentSessionMode,
  AgentSessionSnapshot,
  AgentTerminalSnapshot,
} from './types';

export type AgentSessionModesState = {
  modes: AgentSessionMode[];
  current?: string | null;
};

export type AgentWorkbenchState = {
  connections: Record<string, AgentConnectionSnapshot>;
  sessions: Record<string, AgentSessionSnapshot>;
  prompts: Record<string, AgentPromptSnapshot>;
  permissions: Record<string, AgentPermissionRequest>;
  terminals: Record<string, AgentTerminalSnapshot>;
  sessionModesByScope: Record<string, AgentSessionModesState>;
  sessionConfigOptionsByScope: Record<string, AgentSessionConfigOption[]>;
  availableCommandsByScope: Record<string, AgentAvailableCommand[]>;
  usageByScope: Record<string, { used: number; limit?: number | null }>;
  errorsByScope: Record<string, string[]>;
  eventsByScope: Record<string, AgentEventEnvelope[]>;
  lastSequence: number;
};

export function emptyAgentWorkbenchState(): AgentWorkbenchState {
  return {
    connections: {},
    sessions: {},
    prompts: {},
    permissions: {},
    terminals: {},
    sessionModesByScope: {},
    sessionConfigOptionsByScope: {},
    availableCommandsByScope: {},
    usageByScope: {},
    errorsByScope: {},
    eventsByScope: {},
    lastSequence: 0,
  };
}

export function stateFromAgentSnapshot(
  snapshot: AgentRuntimeSnapshot
): AgentWorkbenchState {
  const snapshotEntities = {
    connections: Object.fromEntries(
      snapshot.connections.map((connection) => [connection.id, connection])
    ),
    sessions: Object.fromEntries(
      snapshot.sessions.map((session) => [session.id, session])
    ),
    prompts: Object.fromEntries(
      snapshot.prompts.map((prompt) => [prompt.id, prompt])
    ),
  };
  const snapshotPermissions = Object.fromEntries(
    (snapshot.permissions ?? []).map((permission) => [
      permission.id,
      permission,
    ])
  );
  const state = snapshot.events.reduce(reduceAgentEvent, {
    ...emptyAgentWorkbenchState(),
    ...snapshotEntities,
  });

  return {
    ...state,
    ...snapshotEntities,
    permissions: {
      ...state.permissions,
      ...snapshotPermissions,
    },
    terminals: {},
    usageByScope: {},
    errorsByScope: {},
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
    connections: state.connections,
    sessions: state.sessions,
    prompts: state.prompts,
    permissions: state.permissions,
    terminals: state.terminals,
    sessionModesByScope: state.sessionModesByScope,
    sessionConfigOptionsByScope: state.sessionConfigOptionsByScope,
    availableCommandsByScope: state.availableCommandsByScope,
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
    case 'session_modes':
      next.sessionModesByScope = {
        ...state.sessionModesByScope,
        [scopeId(envelope)]: {
          modes: envelope.event.modes,
          current: envelope.event.current ?? null,
        },
      };
      return next;
    case 'mode_changed': {
      const scope = scopeId(envelope);
      next.sessionModesByScope = {
        ...state.sessionModesByScope,
        [scope]: {
          modes: state.sessionModesByScope[scope]?.modes ?? [],
          current: envelope.event.mode_id,
        },
      };
      return next;
    }
    case 'session_config_options':
      next.sessionConfigOptionsByScope = {
        ...state.sessionConfigOptionsByScope,
        [scopeId(envelope)]: envelope.event.options,
      };
      return next;
    case 'config_changed': {
      const scope = scopeId(envelope);
      const { key, value } = envelope.event;
      const options = state.sessionConfigOptionsByScope[scope] ?? [];
      next.sessionConfigOptionsByScope = {
        ...state.sessionConfigOptionsByScope,
        [scope]: options.map((option) =>
          option.key === key ? { ...option, value } : option
        ),
      };
      return next;
    }
    case 'available_commands':
      next.availableCommandsByScope = {
        ...state.availableCommandsByScope,
        [scopeId(envelope)]: envelope.event.commands,
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
