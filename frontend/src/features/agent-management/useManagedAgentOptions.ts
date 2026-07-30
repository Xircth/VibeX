import { useMemo } from 'react';
import type { AgentId } from 'shared/types';

import { useSelectableAgents } from '@/features/agents/useSelectableAgents';

export type ManagedAgentOption = {
  value: AgentId;
  label: string;
};

export function useManagedAgentOptions(): ManagedAgentOption[] {
  const agents = useSelectableAgents();
  return useMemo(
    () =>
      agents.map((agent) => ({
        value: agent.agentId,
        label: agent.displayName,
      })),
    [agents]
  );
}
