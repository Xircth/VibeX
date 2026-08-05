import { useMemo } from 'react';
import type { AgentId, AgentSettingsFeature } from 'shared/types';

import { useSelectableAgents } from '@/features/agents/useSelectableAgents';

export type ManagedAgentOption = {
  value: AgentId;
  label: string;
};

export function useManagedAgentOptions(
  requiredFeature?: AgentSettingsFeature
): ManagedAgentOption[] {
  const agents = useSelectableAgents();
  return useMemo(
    () =>
      agents
        .filter(
          (agent) =>
            !requiredFeature || agent.settingsFeatures.includes(requiredFeature)
        )
        .map((agent) => ({
          value: agent.agentId,
          label: agent.displayName,
        })),
    [agents, requiredFeature]
  );
}
