import type { ReactNode } from 'react';
import type { AgentManagementView } from 'shared/types';
import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import { displayUsageLabel } from './usageFormat';

export function favoriteAgentPresentation(
  agentId: string,
  agents: AgentManagementView[],
  notProvided: string
): { node: ReactNode; title: string } {
  const catalog = agents.find((agent) => agent.agent_id === agentId);
  const name =
    catalog?.display_name?.trim() || displayUsageLabel(agentId, notProvided);
  if (name === notProvided) {
    return { node: name, title: name };
  }
  const iconAgent = catalog ?? {
    agent_id: agentId,
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
  };
  return {
    title: name,
    node: (
      <span className="flex min-w-0 items-center gap-1.5">
        <AgentManagementIcon agent={iconAgent} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{name}</span>
      </span>
    ),
  };
}
