import type { AgentManagementView, AgentPreflightItemView } from 'shared/types';

export type AgentProvisioningAction = 'install' | 'repair';

export function agentProvisioningAction(
  agent: Pick<AgentManagementView, 'lifecycle' | 'retired'> & {
    acp_version?: string | null;
  },
  items: AgentPreflightItemView[]
): AgentProvisioningAction | null {
  if (agent.retired || agent.lifecycle === 'platform_unsupported') return null;
  const acpMissing =
    'acp_version' in agent &&
    !agent.acp_version &&
    items.some((item) => item.id === 'acp' && item.status === 'fail');
  if (agent.lifecycle === 'uninstalled' || acpMissing) return 'install';
  const repairableFailure = items.some(
    (item) => item.status === 'fail' && item.repairable
  );
  if (agent.lifecycle === 'needs_repair' || repairableFailure) return 'repair';
  return null;
}
