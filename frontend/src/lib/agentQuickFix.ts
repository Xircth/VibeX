import type { AgentId } from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

/**
 * Onboarding delegates repairs to the same transactional management
 * orchestrator as Settings. There is no second installer or `@latest` path.
 */
export async function applyAgentQuickFix(agentId: AgentId): Promise<number> {
  const report = await agentManagementApi.preflight(agentId);
  if (!report.items.some((item) => item.repairable)) return 0;

  await agentManagementApi.repair(agentId);
  return 1;
}
