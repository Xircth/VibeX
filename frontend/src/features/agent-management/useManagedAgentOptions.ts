import { useMemo } from 'react';
import type { AgentId, AgentSettingsFeature } from 'shared/types';

import { useSelectableAgents } from '@/features/agents/useSelectableAgents';

export type ManagedAgentOption = {
  value: AgentId;
  label: string;
  iconLight: string | null;
  iconDark: string | null;
  iconSvg: string | null;
};

export function useManagedAgentOptions(
  requiredFeature?: AgentSettingsFeature,
  enabledOnly = false
): ManagedAgentOption[] {
  const agents = useSelectableAgents();
  return useMemo(
    () =>
      agents
        .filter(
          (agent) =>
            (!enabledOnly || agent.enabled) &&
            (!requiredFeature ||
              agent.settingsFeatures.includes(requiredFeature))
        )
        .map((agent) => ({
          value: agent.agentId,
          label: agent.displayName,
          iconLight: agent.iconLight ?? null,
          iconDark: agent.iconDark ?? null,
          iconSvg: agent.iconSvg ?? null,
        })),
    [agents, enabledOnly, requiredFeature]
  );
}
