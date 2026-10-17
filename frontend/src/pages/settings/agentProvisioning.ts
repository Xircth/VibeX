import type { AgentManagementView, AgentPreflightItemView } from 'shared/types';

export type AgentProvisioningAction = 'install' | 'repair';

export function agentProvisioningAction(
  agent: Pick<AgentManagementView, 'lifecycle' | 'retired'>,
  items: AgentPreflightItemView[]
): AgentProvisioningAction | null {
  if (agent.retired || agent.lifecycle === 'platform_unsupported') return null;
  if (agent.lifecycle === 'uninstalled') return 'install';
  const repairableFailure = items.some(
    (item) => item.status === 'fail' && item.repairable
  );
  if (agent.lifecycle === 'needs_repair' || repairableFailure) return 'repair';
  return null;
}
