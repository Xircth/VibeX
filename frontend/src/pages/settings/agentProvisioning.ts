import type { AgentManagementView, AgentPreflightItemView } from 'shared/types';

export type AgentProvisioningAction = 'install' | 'repair';

export type NativeEngineAgentHint =
  | string
  | {
      agent_id?: string | null;
      id?: string | null;
      agentId?: string | null;
      topology?: string | null;
    }
  | null
  | undefined;

const NATIVE_ENGINE_AGENT_IDS = new Set(['claude_code', 'codex']);

export function isNativeEngineAgent(agentOrId?: NativeEngineAgentHint): boolean {
  if (!agentOrId) return false;
  if (typeof agentOrId === 'string') {
    return NATIVE_ENGINE_AGENT_IDS.has(agentOrId);
  }
  if (agentOrId.topology === 'native_engine') return true;
  if (agentOrId.topology && agentOrId.topology !== 'native_engine') {
    return false;
  }
  const id = agentOrId.agent_id ?? agentOrId.id ?? agentOrId.agentId ?? '';
  return NATIVE_ENGINE_AGENT_IDS.has(id);
}

export function isPrimaryRuntimePreflightItem(
  item: Pick<AgentPreflightItemView, 'id'>,
  agentOrId?: NativeEngineAgentHint
): boolean {
  if (item.id === 'acp' || item.id === 'native_runtime') return true;
  return isNativeEngineAgent(agentOrId) && item.id === 'runtime';
}

export function agentProvisioningAction(
  agent: Pick<AgentManagementView, 'lifecycle' | 'retired'> & {
    agent_id?: string | null;
    id?: string | null;
    topology?: string | null;
    acp_version?: string | null;
    runtime_version?: string | null;
    local_runtime?: {
      version?: string | null;
      path?: string | null;
    } | null;
  },
  items: AgentPreflightItemView[]
): AgentProvisioningAction | null {
  if (agent.retired || agent.lifecycle === 'platform_unsupported') return null;
  const nativeEngine = isNativeEngineAgent(agent);
  const primaryItem =
    items.find((item) => isPrimaryRuntimePreflightItem(item, agent)) ??
    items.find((item) => item.id === 'acp');
  if (primaryItem && primaryItem.status === 'fail' && !primaryItem.repairable) {
    return null;
  }
  const hasNativeRuntimeEvidence =
    nativeEngine &&
    Boolean(
      agent.runtime_version ||
        agent.acp_version ||
        agent.local_runtime?.path ||
        agent.local_runtime?.version
    );
  const primaryMissing = nativeEngine
    ? ('acp_version' in agent || 'runtime_version' in agent) &&
      !hasNativeRuntimeEvidence &&
      Boolean(primaryItem && primaryItem.status === 'fail')
    : 'acp_version' in agent &&
      !agent.acp_version &&
      items.some((item) => item.id === 'acp' && item.status === 'fail');
  if (
    (agent.lifecycle === 'uninstalled' && !hasNativeRuntimeEvidence) ||
    primaryMissing
  ) {
    return 'install';
  }
  const repairableFailure = items.some(
    (item) => item.status === 'fail' && item.repairable
  );
  if (agent.lifecycle === 'needs_repair' || repairableFailure) return 'repair';
  return null;
}
