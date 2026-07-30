import type {
  AgentLifecycleState,
  AgentManagementView,
  AgentOperationEvent,
  AgentOperationKind,
  AgentRegistryViewRow,
} from 'shared/types';

export type AgentOperationState = {
  operationId: string;
  kind: AgentOperationKind;
  status: AgentOperationEvent['status'];
  progressPercent: number | null;
  message: string | null;
  sequence: number;
};

export type AgentManagementState = {
  agents: AgentManagementView[];
  selectedAgentId: string | null;
  operations: Record<string, AgentOperationState>;
  lastEventSequence: number;
  snapshotRevision: number;
};

export function createAgentManagementState(
  agents: AgentManagementView[]
): AgentManagementState {
  const sorted = sortAgents(agents);
  return {
    agents: sorted,
    selectedAgentId: sorted[0]?.agent_id ?? null,
    operations: {},
    lastEventSequence: 0,
    snapshotRevision: 0,
  };
}

export function optimisticAddRegistryAgent(
  state: AgentManagementState,
  row: AgentRegistryViewRow
): AgentManagementState {
  if (state.agents.some((agent) => agent.agent_id === row.agent_id)) {
    return { ...state, selectedAgentId: row.agent_id };
  }
  const position =
    state.agents.reduce((highest, agent) => Math.max(highest, agent.position), -1) +
    1;
  const optimistic: AgentManagementView = {
    agent_id: row.agent_id,
    display_name: row.display_name,
    description: row.description,
    icon_light: row.icon_light,
    icon_dark: row.icon_dark,
    icon_svg: row.icon_svg,
    source: 'official_registry',
    built_in: row.built_in,
    retired: false,
    enabled: true,
    position,
    lifecycle: row.platform_supported ? 'queued' : 'platform_unsupported',
    authentication: 'not_logged_in',
    runtime_version: null,
    acp_version: null,
    active_operation: row.platform_supported ? 'install' : null,
    rollback_available: false,
  };
  return {
    ...state,
    agents: [...state.agents, optimistic],
    selectedAgentId: row.agent_id,
  };
}

export function reduceOperationEvent(
  state: AgentManagementState,
  event: AgentOperationEvent
): AgentManagementState {
  if (event.sequence <= state.lastEventSequence) return state;

  const terminal =
    event.status === 'succeeded' ||
    event.status === 'failed' ||
    event.status === 'canceled';
  const lifecycle = lifecycleForOperation(event);
  const agents = state.agents.map((agent) =>
    agent.agent_id === event.agent_id
      ? {
          ...agent,
          lifecycle,
          active_operation: terminal ? null : event.kind,
        }
      : agent
  );
  const operations = { ...state.operations };
  if (terminal) {
    delete operations[event.agent_id];
  } else {
    operations[event.agent_id] = {
      operationId: event.operation_id,
      kind: event.kind,
      status: event.status,
      progressPercent: event.progress_percent,
      message: event.message,
      sequence: event.sequence,
    };
  }
  return {
    ...state,
    agents,
    operations,
    lastEventSequence: event.sequence,
  };
}

export function mergeManagementSnapshot(
  state: AgentManagementState,
  agents: AgentManagementView[]
): AgentManagementState {
  const authoritativeIds = new Set(agents.map((agent) => agent.agent_id));
  const operations = Object.fromEntries(
    Object.entries(state.operations).filter(([agentId]) => {
      const agent = agents.find((item) => item.agent_id === agentId);
      return authoritativeIds.has(agentId) && agent?.active_operation != null;
    })
  );
  const sorted = sortAgents(agents);
  return {
    ...state,
    agents: sorted,
    selectedAgentId:
      state.selectedAgentId &&
      sorted.some((agent) => agent.agent_id === state.selectedAgentId)
        ? state.selectedAgentId
        : (sorted[0]?.agent_id ?? null),
    operations,
    snapshotRevision: state.snapshotRevision + 1,
  };
}

function lifecycleForOperation(
  event: AgentOperationEvent
): AgentLifecycleState {
  if (event.status === 'failed' || event.status === 'canceled') {
    return 'needs_repair';
  }
  if (event.status === 'succeeded') return 'ready';
  if (event.status === 'queued') return 'queued';
  switch (event.kind) {
    case 'install':
      return 'installing';
    case 'update':
      return 'updating';
    case 'repair':
    case 'rollback':
      return 'repairing';
    case 'uninstall':
    case 'remove':
    case 'check':
      return 'queued';
  }
}

function sortAgents(agents: AgentManagementView[]): AgentManagementView[] {
  return [...agents].sort(
    (left, right) =>
      left.position - right.position ||
      left.display_name.localeCompare(right.display_name)
  );
}
